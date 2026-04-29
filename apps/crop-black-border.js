import path from 'path'
import fs from 'fs/promises'
import sharp from 'sharp'
import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  isHttpUrl,
  normalizeForApi,
  getSegField,
  downloadMediaToTemp,
  ensureTempDir,
  cleanupTempFile,
  delayedDelete,
  formatSizeMB,
} from './utils.js'

const execFileAsync = promisify(execFile)

const segment = global.segment

const TEMP_DIR = path.join(process.cwd(), 'temp', 'ffmpeg')
const MAX_SIZE_MB = 10
const MAX_BATCH_COUNT = 10
const DELAY_DELETE_SECONDS = 60

const COLOR_TRIM_THRESHOLD = 40
const CROP_INSET = 3

// ================= 递归提取消息中的所有图片和视频 =================
async function extractMediaRecursivelyAsync(message, bot, target) {
  const mediaList = []

  const pickForwardIdFromJson = (jsonData) => {
    if (!jsonData || typeof jsonData !== 'string') return null
    const matched = jsonData.match(/"resid":"(.*?)"/)
    return matched?.[1] || null
  }

  if (Array.isArray(message)) {
    for (const seg of message) {
      if (seg.type === 'image' || seg.type === 'video') {
        const url = await resolveMediaUrl(seg, target)
        if (url) mediaList.push({ type: seg.type, url })
        continue
      }

      if (seg.type === 'json') {
        const forwardId = pickForwardIdFromJson(seg.data)
        if (forwardId && bot?.getForwardMsg) {
          try {
            const forwardMsgs = await bot.getForwardMsg(forwardId)
            for (const node of forwardMsgs || []) {
              if (Array.isArray(node?.message)) {
                const subMedia = await extractMediaRecursivelyAsync(node.message, bot, target)
                mediaList.push(...subMedia)
              }
            }
          } catch (err) {
            logger.error('[裁剪] 获取 json 转发内容失败:', err)
          }
        }
        continue
      }

      if (seg.type === 'forward') {
        const forwardContent = seg.content || seg.data?.content
        if (Array.isArray(forwardContent)) {
          for (const item of forwardContent) {
            if (item?.message) {
              const subMedia = await extractMediaRecursivelyAsync(item.message, bot, target)
              mediaList.push(...subMedia)
            }
          }
          continue
        }

        const forwardId = seg.id || seg.data?.id
        if (forwardId && bot?.getForwardMsg) {
          try {
            const forwardMsgs = await bot.getForwardMsg(forwardId)
            for (const node of forwardMsgs || []) {
              if (Array.isArray(node?.message)) {
                const subMedia = await extractMediaRecursivelyAsync(node.message, bot, target)
                mediaList.push(...subMedia)
              }
            }
          } catch (err) {
            logger.error('[裁剪] 获取 forward 转发内容失败:', err)
          }
        }
      }
    }
  } else if (message && typeof message === 'object') {
    const msgArray = message.message
    if (Array.isArray(msgArray)) {
      const subMedia = await extractMediaRecursivelyAsync(msgArray, bot, target)
      mediaList.push(...subMedia)
    }
  }

  return mediaList
}

// ================= 媒体 URL 解析 =================
async function resolveMediaUrl(seg, target) {
  const candidates = [
    getSegField(seg, 'url'),
    getSegField(seg, 'file'),
    getSegField(seg, 'src'),
    getSegField(seg, 'origin')
  ]

  for (const candidate of candidates) {
    if (isHttpUrl(candidate)) return candidate
  }

  const segPayload = normalizeForApi(seg)

  if (seg?.type === 'video' && target?.getVideoUrl) {
    try {
      const url = await target.getVideoUrl(segPayload)
      if (isHttpUrl(url)) return url
    } catch (err) {
      logger.warn(`[裁剪] getVideoUrl 失败: ${err.message}`)
    }
  }

  if (seg?.type === 'image' && target?.getPicUrl) {
    try {
      const url = await target.getPicUrl(segPayload)
      if (isHttpUrl(url)) return url
    } catch (err) {
      logger.warn(`[裁剪] getPicUrl 失败: ${err.message}`)
    }
  }

  const fid = getSegField(seg, 'fid')
  if (fid && target?.getFileUrl) {
    try {
      const url = await target.getFileUrl(fid)
      if (isHttpUrl(url)) return url
    } catch (err) {
      logger.warn(`[裁剪] getFileUrl 失败: ${err.message}`)
    }
  }

  return null
}

// ================= 图片裁剪（基于角点颜色 + 内偏移） =================

/**
 * 从多个角点采样背景色，取中值，更稳健
 */
function sampleBgColor(data, width, height, channels) {
  const samples = []
  // 四角 + 边缘多个采样点
  const points = [
    [0, 0], [1, 0], [0, 1], [2, 0], [0, 2],
    [width - 1, 0], [width - 2, 0], [width - 1, 1],
    [0, height - 1], [1, height - 1], [0, height - 2],
    [width - 1, height - 1], [width - 2, height - 1], [width - 1, height - 2],
  ]
  for (const [x, y] of points) {
    const idx = (y * width + x) * channels
    samples.push([data[idx], data[idx + 1], data[idx + 2]])
  }
  const rVals = samples.map(s => s[0]).sort((a, b) => a - b)
  const gVals = samples.map(s => s[1]).sort((a, b) => a - b)
  const bVals = samples.map(s => s[2]).sort((a, b) => a - b)
  const mid = Math.floor(samples.length / 2)
  return [rVals[mid], gVals[mid], bVals[mid]]
}

async function cropImageByCornerColor(inputPath, outputPath, threshold, inset) {
  try {
    const image = sharp(inputPath)
    const metadata = await image.metadata()
    const { width, height, channels } = metadata
    if (!width || !height) return false

    const { data } = await image.raw().toBuffer({ resolveWithObject: true })

    const [baseR, baseG, baseB] = sampleBgColor(data, width, height, channels)

    const colorDist = (r, g, b) => {
      const dr = r - baseR
      const dg = g - baseG
      const db = b - baseB
      return Math.sqrt(dr * dr + dg * dg + db * db)
    }

    // 采样步长：大图跳着扫，提升性能
    const stepX = width > 1000 ? 4 : (width > 500 ? 2 : 1)
    const stepY = height > 1000 ? 4 : (height > 500 ? 2 : 1)

    const isRowBg = (y, step = stepX) => {
      for (let x = 0; x < width; x += step) {
        const idx = (y * width + x) * channels
        if (colorDist(data[idx], data[idx + 1], data[idx + 2]) > threshold) return false
      }
      return true
    }

    const isColBg = (x, step = stepY) => {
      for (let y = 0; y < height; y += step) {
        const idx = (y * width + x) * channels
        if (colorDist(data[idx], data[idx + 1], data[idx + 2]) > threshold) return false
      }
      return true
    }

    // 粗扫描上边界
    let top = 0
    for (let y = 0; y < height; y += stepY) {
      if (!isRowBg(y)) { top = y; break }
    }
    // 回扫修正
    top = Math.max(0, top - stepY)
    for (let y = top; y < height; y++) {
      if (!isRowBg(y, 1)) { top = y; break }
    }

    // 粗扫描下边界
    let bottom = height - 1
    for (let y = height - 1; y >= 0; y -= stepY) {
      if (!isRowBg(y)) { bottom = y; break }
    }
    bottom = Math.min(height - 1, bottom + stepY)
    for (let y = bottom; y >= 0; y--) {
      if (!isRowBg(y, 1)) { bottom = y; break }
    }

    // 粗扫描左边界
    let left = 0
    for (let x = 0; x < width; x += stepX) {
      if (!isColBg(x)) { left = x; break }
    }
    left = Math.max(0, left - stepX)
    for (let x = left; x < width; x++) {
      if (!isColBg(x, 1)) { left = x; break }
    }

    // 粗扫描右边界
    let right = width - 1
    for (let x = width - 1; x >= 0; x -= stepX) {
      if (!isColBg(x)) { right = x; break }
    }
    right = Math.min(width - 1, right + stepX)
    for (let x = right; x >= 0; x--) {
      if (!isColBg(x, 1)) { right = x; break }
    }

    // 应用内偏移
    let cropLeft = left + inset
    let cropTop = top + inset
    let cropRight = right - inset
    let cropBottom = bottom - inset

    if (cropLeft >= cropRight || cropTop >= cropBottom) {
      logger.warn('[裁剪] 向内偏移后裁剪区域无效，可能原图过小')
      return false
    }

    const cropWidth = cropRight - cropLeft + 1
    const cropHeight = cropBottom - cropTop + 1
    if (cropWidth <= 0 || cropHeight <= 0) return false

    await sharp(inputPath)
      .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
      .toFile(outputPath)

    logger.info(`[裁剪] 完成: left=${cropLeft}, top=${cropTop}, width=${cropWidth}, height=${cropHeight}`)
    return true
  } catch (err) {
    logger.error(`[裁剪] 图片处理失败: ${err.message}`)
    return false
  }
}

// ================= 视频裁剪参数调整 =================
function adjustCropFilter(cropFilter, inset) {
  const match = cropFilter.match(/crop=(\d+):(\d+):(\d+):(\d+)/)
  if (!match) return cropFilter
  let w = parseInt(match[1], 10)
  let h = parseInt(match[2], 10)
  let x = parseInt(match[3], 10)
  let y = parseInt(match[4], 10)

  let newX = x + inset
  let newY = y + inset
  let newW = w - inset * 2
  let newH = h - inset * 2

  if (newW <= 0 || newH <= 0) {
    logger.warn('[裁剪] 向内偏移后尺寸无效，保持原参数')
    return cropFilter
  }

  newW = newW % 2 === 0 ? newW : newW - 1
  newH = newH % 2 === 0 ? newH : newH - 1
  if (newW <= 0 || newH <= 0) return cropFilter

  return `crop=${newW}:${newH}:${newX}:${newY}`
}

// ================= 视频裁剪核心 =================
async function cropVideoWithFFmpeg(inputPath, outputPath, useNegate = false) {
  const detectFilter = useNegate ? 'negate,cropdetect=24:8:0' : 'cropdetect=24:8:0'
  const detectArgs = [
    '-y', '-i', inputPath,
    '-vf', detectFilter,
    '-vframes', '20',
    '-f', 'null', '-'
  ]
  logger.info(`[视频裁剪] 执行检测命令: ffmpeg ${detectArgs.join(' ')}`)
  try {
    const { stderr } = await execFileAsync('ffmpeg', detectArgs)
    const matches = stderr.match(/crop=[0-9]+:[0-9]+:[0-9]+:[0-9]+/g)
    if (!matches || matches.length === 0) {
      logger.info('[视频裁剪] 未检测到黑/白边')
      return false
    }
    const rawCrop = matches[matches.length - 1]
    logger.info(`[视频裁剪] 原始检测参数: ${rawCrop}`)
    const adjustedCrop = adjustCropFilter(rawCrop, CROP_INSET)
    logger.info(`[视频裁剪] 调整后参数: ${adjustedCrop}`)

    const cropArgs = [
      '-y', '-i', inputPath,
      '-vf', adjustedCrop,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'copy', outputPath
    ]
    const { stderr: cropStderr } = await execFileAsync('ffmpeg', cropArgs)
    if (cropStderr) logger.info(`[视频裁剪] FFmpeg 输出:\n${cropStderr.slice(0, 500)}`)
    logger.info(`[视频裁剪] 完成，输出: ${outputPath}`)
    return true
  } catch (err) {
    logger.error(`[视频裁剪] 失败: ${err.message}`)
    if (err.stderr) logger.error(err.stderr)
    return false
  }
}

// ================= 统一媒体处理入口 =================
async function cropMedia(inputPath, outputPath, type, mode) {
  if (type === 'image') {
    // 黑边：取左上角颜色（通常是黑色）裁剪
    // 白边：取左上角颜色（通常是白色）裁剪
    // 纯色：同上，取左上角颜色裁剪
    // 三种模式图片处理逻辑相同，都是基于角点颜色做连续色区域裁剪
    return await cropImageByCornerColor(inputPath, outputPath, COLOR_TRIM_THRESHOLD, CROP_INSET)
  } else {
    // 视频：白边用 negate 反转后检测，黑边直接检测
    if (mode === 'white') {
      return await cropVideoWithFFmpeg(inputPath, outputPath, true)
    } else {
      return await cropVideoWithFFmpeg(inputPath, outputPath, false)
    }
  }
}

// ================= QQ 机器人插件类 =================
export class cropBlackBorder extends plugin {
  constructor() {
    super({
      name: '[裁剪插件]去黑边/去白边/去纯色',
      event: 'message',
      priority: 1000,
      rule: [
        { reg: '^#?去黑边$', fnc: 'crop' },
        { reg: '^#?去白边$', fnc: 'cropWhite' },
        { reg: '^#?去纯色$', fnc: 'cropSolidColor' }
      ]
    })
  }

  async extractMediaFromMsg(messageArray, bot, target) {
    if (!Array.isArray(messageArray)) return []
    return await extractMediaRecursivelyAsync(messageArray, bot, target)
  }

  async getReplyMedia(e) {
    if (e.getReply) {
      try {
        const rawMsg = await e.getReply()
        if (rawMsg?.message) {
          const target = e[e.isGroup ? 'group' : 'friend']
          return await this.extractMediaFromMsg(rawMsg.message, e.bot, target)
        }
      } catch (err) {
        logger.error('[裁剪] 通过 getReply 获取消息失败:', err)
      }
    }

    if (e.source) {
      try {
        const target = e[e.isGroup ? 'group' : 'friend']
        if (target?.getChatHistory) {
          const seq = e.isGroup ? e.source.seq : (e.source.time ? e.source.time + 1 : undefined)
          if (seq !== undefined) {
            const msgs = await target.getChatHistory(seq, 1)
            const rawMsg = msgs.pop()
            if (rawMsg?.message) {
              return await this.extractMediaFromMsg(rawMsg.message, e.bot, target)
            }
          }
        }
      } catch (err) {
        logger.error('[裁剪] 通过 source 获取消息失败:', err)
      }
    }
    return []
  }

  // 通用批量处理逻辑
  async processMedia(e, mode) {
    const modeName = mode === 'black' ? '去黑边' : (mode === 'white' ? '去白边' : '去纯色')
    let mediaList = []

    const replyMedia = await this.getReplyMedia(e)
    if (replyMedia.length > 0) {
      mediaList = replyMedia
    }
    if (mediaList.length === 0 && e.message) {
      const target = e[e.isGroup ? 'group' : 'friend']
      mediaList = await this.extractMediaFromMsg(e.message, e.bot, target)
    }
    if (mediaList.length === 0) {
      return e.reply(`❌ 请回复或引用一条包含图片/视频的消息，或直接发送带有图片/视频的命令。`, true)
    }

    if (mode === 'solid') {
      mediaList = mediaList.filter(m => m.type === 'image')
      if (mediaList.length === 0) {
        return e.reply(`❌ "去纯色"功能仅支持图片，不支持视频。`, true)
      }
    }

    if (mediaList.length > MAX_BATCH_COUNT) {
      return e.reply(`❌ 媒体数量过多！一次最多处理 ${MAX_BATCH_COUNT} 个。`, true)
    }

    const isBatch = mediaList.length > 1
    await e.reply(isBatch ? `📦 发现 ${mediaList.length} 个媒体，开始批量处理（${modeName}），请耐心等待...` : `✂️ 正在处理中（${modeName}），请稍候...`, true)

    const tempFilesPool = []
    const successItems = []
    const failReasons = []

    try {
      for (let idx = 0; idx < mediaList.length; idx++) {
        const media = mediaList[idx]
        const url = media.url
        if (!url) {
          failReasons.push(`第 ${idx + 1} 个媒体：无法获取 URL`)
          continue
        }

        let inputPath = null, outputPath = null
        try {
          inputPath = await downloadMediaToTemp(url)
          tempFilesPool.push(inputPath)

          const isImage = media.type === 'image' || /\.(jpg|jpeg|png|bmp|webp)$/i.test(path.extname(inputPath))
          const outExt = isImage ? '.jpg' : '.mp4'
          const baseName = path.basename(inputPath, path.extname(inputPath))
          const suffix = mode === 'white' ? '_white' : (mode === 'solid' ? '_solid' : '')
          outputPath = path.join(TEMP_DIR, `${baseName}_cropped${suffix}${outExt}`)
          tempFilesPool.push(outputPath)

          const success = await cropMedia(inputPath, outputPath, isImage ? 'image' : 'video', mode)
          if (success && await fs.stat(outputPath).then(() => true).catch(() => false)) {
            successItems.push({ path: outputPath, type: isImage ? 'image' : 'video' })
          } else {
            failReasons.push(`第 ${idx + 1} 个${isImage ? '图片' : '视频'}处理失败：可能是未检测到边缘或格式不支持。`)
          }
        } catch (err) {
          logger.error(`[${modeName}] 处理异常:`, err)
          failReasons.push(`第 ${idx + 1} 个媒体处理异常：${err.message}`)
        }
      }

      if (failReasons.length > 0) {
        await e.reply(`❌ 批量处理中发生以下错误：\n${failReasons.map((r, i) => `${i + 1}. ${r}`).join('\n')}`, true)
      }
      if (successItems.length === 0) return

      if (successItems.length === 1) {
        const item = successItems[0]
        await e.reply(segment.image(item.path))
      } else {
        await e.reply(`✅ 成功处理 ${successItems.length} 个媒体（${modeName}），正在打包合并转发...`, true)
        const forwardNodes = []
        const botUin = e.bot.uin || e.bot.selfId || '10000'
        const botName = modeName + '助手'
        for (const item of successItems) {
          forwardNodes.push({
            user_id: String(botUin),
            nickname: botName,
            message: item.type === 'image' ? segment.image(item.path) : segment.video(item.path)
          })
        }
        try {
          const forwardMsg = e.isGroup
            ? await e.group.makeForwardMsg(forwardNodes)
            : await e.friend.makeForwardMsg(forwardNodes)
          await e.reply(forwardMsg)
        } catch (forwardErr) {
          logger.error(`[${modeName}] 合并转发失败，回退逐条发送:`, forwardErr)
          await e.reply('⚠️ 合并转发发送失败，改为逐条发送。', true)
          for (const item of successItems) {
            await e.reply(segment.image(item.path))
          }
        }
      }
    } finally {
      if (tempFilesPool.length) delayedDelete(tempFilesPool, DELAY_DELETE_SECONDS)
    }
  }

  async crop(e)          { await this.processMedia(e, 'black') }
  async cropWhite(e)    { await this.processMedia(e, 'white') }
  async cropSolidColor(e) { await this.processMedia(e, 'solid') }
}
