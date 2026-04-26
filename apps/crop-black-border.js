import { exec } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import { createWriteStream } from 'fs'
import path from 'path'
import axios from 'axios'
import sharp from 'sharp'

const execPromise = promisify(exec)

const TEMP_DIR = path.join(process.cwd(), 'temp', 'ffmpeg')
const MAX_SIZE_MB = 10
const MAX_BATCH_COUNT = 10
const DELAY_DELETE_SECONDS = 60

// 颜色容差（欧几里得距离阈值）
const COLOR_TRIM_THRESHOLD = 24
// 裁剪向内偏移像素（避免边缘过渡残留）
const CROP_INSET = 3

async function ensureTempDir() {
    await fs.mkdir(TEMP_DIR, { recursive: true })
}

function getSafeExtFromUrl(url) {
    try {
        const urlObj = new URL(url)
        const pathname = urlObj.pathname
        let ext = path.extname(pathname)
        if (ext && ext !== '.') {
            ext = ext.split('?')[0]
            ext = ext.replace(/[^a-zA-Z0-9.]/g, '')
            if (ext.length > 1 && ext[0] === '.') return ext
        }
    } catch (e) {}
    return '.tmp'
}

async function downloadMediaToTemp(url, fallbackExt = null) {
    await ensureTempDir()
    const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'stream',
        timeout: 60000,
        maxContentLength: MAX_SIZE_MB * 1024 * 1024,
        maxBodyLength: MAX_SIZE_MB * 1024 * 1024
    })
    let ext = fallbackExt && /^\.[a-zA-Z0-9]+$/.test(fallbackExt) ? fallbackExt : null
    if (!ext) ext = getSafeExtFromUrl(url)
    const tempFile = path.join(TEMP_DIR, `crop_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`)
    const writer = createWriteStream(tempFile)
    response.data.pipe(writer)
    await new Promise((resolve, reject) => {
        writer.on('finish', resolve)
        writer.on('error', reject)
    })
    console.log(`[裁剪] 已下载临时文件: ${tempFile} (${(await fs.stat(tempFile)).size} bytes)`)
    return tempFile
}

/**
 * 递归提取消息中的所有图片和视频（异步，支持合并转发）
 */
async function extractMediaRecursivelyAsync(message, bot) {
    const mediaList = []

    const pickForwardIdFromJson = (jsonData) => {
        if (!jsonData || typeof jsonData !== 'string') return null
        const matched = jsonData.match(/"resid":"(.*?)"/)
        return matched?.[1] || null
    }

    if (Array.isArray(message)) {
        for (const seg of message) {
            if (seg.type === 'image' || seg.type === 'video') {
                const url = seg.url || seg.data?.url || seg.file || seg.data?.file
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
                                const subMedia = await extractMediaRecursivelyAsync(node.message, bot)
                                mediaList.push(...subMedia)
                            }
                        }
                    } catch (err) {
                        console.error('[裁剪] 获取 json 转发内容失败:', err)
                    }
                }
                continue
            }

            if (seg.type === 'forward') {
                const forwardContent = seg.content || seg.data?.content
                if (Array.isArray(forwardContent)) {
                    for (const item of forwardContent) {
                        if (item?.message) {
                            const subMedia = await extractMediaRecursivelyAsync(item.message, bot)
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
                                const subMedia = await extractMediaRecursivelyAsync(node.message, bot)
                                mediaList.push(...subMedia)
                            }
                        }
                    } catch (err) {
                        console.error('[裁剪] 获取 forward 转发内容失败:', err)
                    }
                }
            }
        }
    } else if (message && typeof message === 'object') {
        const msgArray = message.message
        if (Array.isArray(msgArray)) {
            const subMedia = await extractMediaRecursivelyAsync(msgArray, bot)
            mediaList.push(...subMedia)
        }
    }

    return mediaList
}

// ================= 图片通用裁剪（基于角点颜色 + 内偏移） =================
/**
 * 根据指定角点的颜色，裁剪掉边缘连续相似色，并向内偏移指定像素
 * @param {string} inputPath   输入图片路径
 * @param {string} outputPath  输出图片路径
 * @param {number} threshold   颜色欧氏距离阈值
 * @param {number} inset       裁剪后向内收缩像素（避免边缘过渡）
 * @param {string} corner      角点位置：'top-left', 'top-right', 'bottom-left', 'bottom-right'
 * @returns {Promise<boolean>} 是否成功裁剪（无裁剪或出错返回false）
 */
async function cropImageByCornerColor(inputPath, outputPath, threshold, inset, corner = 'top-left') {
    try {
        const image = sharp(inputPath)
        const metadata = await image.metadata()
        const { width, height, channels } = metadata
        if (!width || !height) return false

        // 获取原始像素缓冲区
        const { data } = await image.raw().toBuffer({ resolveWithObject: true })

        // 确定角点坐标
        let cornerX = 0, cornerY = 0
        switch (corner) {
            case 'top-right':    cornerX = width - 1; break
            case 'bottom-left':  cornerY = height - 1; break
            case 'bottom-right': cornerX = width - 1; cornerY = height - 1; break
            default: // top-left
                break
        }
        const cornerIdx = (cornerY * width + cornerX) * channels
        const baseR = data[cornerIdx]
        const baseG = data[cornerIdx + 1]
        const baseB = data[cornerIdx + 2]

        const colorDist = (r, g, b) => {
            const dr = r - baseR
            const dg = g - baseG
            const db = b - baseB
            return Math.sqrt(dr * dr + dg * dg + db * db)
        }

        // 扫描上边界（从上往下）
        let top = 0
        for (let y = 0; y < height; y++) {
            let rowAllBg = true
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * channels
                if (colorDist(data[idx], data[idx+1], data[idx+2]) > threshold) {
                    rowAllBg = false
                    break
                }
            }
            if (!rowAllBg) {
                top = y
                break
            }
        }

        // 下边界（从下往上）
        let bottom = height - 1
        for (let y = height - 1; y >= 0; y--) {
            let rowAllBg = true
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * channels
                if (colorDist(data[idx], data[idx+1], data[idx+2]) > threshold) {
                    rowAllBg = false
                    break
                }
            }
            if (!rowAllBg) {
                bottom = y
                break
            }
        }

        // 左边界（从左往右）
        let left = 0
        for (let x = 0; x < width; x++) {
            let colAllBg = true
            for (let y = 0; y < height; y++) {
                const idx = (y * width + x) * channels
                if (colorDist(data[idx], data[idx+1], data[idx+2]) > threshold) {
                    colAllBg = false
                    break
                }
            }
            if (!colAllBg) {
                left = x
                break
            }
        }

        // 右边界（从右往左）
        let right = width - 1
        for (let x = width - 1; x >= 0; x--) {
            let colAllBg = true
            for (let y = 0; y < height; y++) {
                const idx = (y * width + x) * channels
                if (colorDist(data[idx], data[idx+1], data[idx+2]) > threshold) {
                    colAllBg = false
                    break
                }
            }
            if (!colAllBg) {
                right = x
                break
            }
        }

        // 应用内偏移
        let cropLeft = left + inset
        let cropTop = top + inset
        let cropRight = right - inset
        let cropBottom = bottom - inset

        if (cropLeft >= cropRight || cropTop >= cropBottom) {
            console.log('[裁剪] 向内偏移后裁剪区域无效，可能原图过小')
            return false
        }

        const cropWidth = cropRight - cropLeft + 1
        const cropHeight = cropBottom - cropTop + 1
        if (cropWidth <= 0 || cropHeight <= 0) return false

        await sharp(inputPath)
            .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
            .toFile(outputPath)

        console.log(`[裁剪] 完成: left=${cropLeft}, top=${cropTop}, width=${cropWidth}, height=${cropHeight}`)
        return true
    } catch (err) {
        console.error(`[裁剪] 图片处理失败: ${err.message}`)
        return false
    }
}

// ================= 视频裁剪参数调整（内偏移 + 宽高偶数） =================
/**
 * 调整 crop 滤镜参数，向内偏移指定像素，并确保宽高为偶数
 * @param {string} cropFilter 原始 crop 字符串，如 "crop=1920:1080:0:0"
 * @param {number} inset      向内偏移像素
 * @returns {string} 调整后的 crop 字符串
 */
function adjustCropFilter(cropFilter, inset) {
    const match = cropFilter.match(/crop=(\d+):(\d+):(\d+):(\d+)/)
    if (!match) return cropFilter
    let w = parseInt(match[1], 10)
    let h = parseInt(match[2], 10)
    let x = parseInt(match[3], 10)
    let y = parseInt(match[4], 10)

    // 向内收缩
    let newX = x + inset
    let newY = y + inset
    let newW = w - inset * 2
    let newH = h - inset * 2

    // 边界保护
    if (newW <= 0 || newH <= 0) {
        console.warn('[裁剪] 向内偏移后尺寸无效，保持原参数')
        return cropFilter
    }

    // 确保宽高为偶数（H.264 要求）
    newW = newW % 2 === 0 ? newW : newW - 1
    newH = newH % 2 === 0 ? newH : newH - 1
    if (newW <= 0 || newH <= 0) return cropFilter

    return `crop=${newW}:${newH}:${newX}:${newY}`
}

// ================= 视频裁剪核心（去黑边/去白边） =================
async function cropVideoWithFFmpeg(inputPath, outputPath, useNegate = false) {
    const detectFilter = useNegate ? 'negate,cropdetect=24:8:0' : 'cropdetect=24:8:0'
    const detectCmd = [
        'ffmpeg', '-y', '-i', inputPath,
        '-vf', detectFilter,
        '-vframes', '20',
        '-f', 'null', '-'
    ]
    console.log(`[视频裁剪] 执行检测命令: ${detectCmd.join(' ')}`)
    try {
        const { stderr } = await execPromise(detectCmd.join(' '))
        const matches = stderr.match(/crop=[0-9]+:[0-9]+:[0-9]+:[0-9]+/g)
        if (!matches || matches.length === 0) {
            console.log('[视频裁剪] 未检测到黑/白边')
            return false
        }
        const rawCrop = matches[matches.length - 1]
        console.log(`[视频裁剪] 原始检测参数: ${rawCrop}`)
        const adjustedCrop = adjustCropFilter(rawCrop, CROP_INSET)
        console.log(`[视频裁剪] 调整后参数: ${adjustedCrop}`)

        const cropCmd = [
            'ffmpeg', '-y', '-i', inputPath,
            '-vf', adjustedCrop,
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
            '-c:a', 'copy', outputPath
        ]
        const { stderr: cropStderr } = await execPromise(cropCmd.join(' '))
        if (cropStderr) console.log(`[视频裁剪] FFmpeg 输出:\n${cropStderr}`)
        console.log(`[视频裁剪] 完成，输出: ${outputPath}`)
        return true
    } catch (err) {
        console.error(`[视频裁剪] 失败: ${err.message}`)
        if (err.stderr) console.error(err.stderr)
        return false
    }
}

// ================= 统一媒体处理入口（图片/视频） =================
async function cropMedia(inputPath, outputPath, type, mode) {
    // mode: 'black' (去黑边), 'white' (去白边), 'solid' (去纯色，仅图片)
    if (type === 'image') {
        if (mode === 'solid') {
            // 去纯色：基于左上角颜色裁剪
            return await cropImageByCornerColor(inputPath, outputPath, COLOR_TRIM_THRESHOLD, CROP_INSET, 'top-left')
        } else {
            // 去黑边/白边：基于左上角颜色（黑或白）裁剪
            return await cropImageByCornerColor(inputPath, outputPath, COLOR_TRIM_THRESHOLD, CROP_INSET, 'top-left')
        }
    } else { // video
        if (mode === 'white') {
            return await cropVideoWithFFmpeg(inputPath, outputPath, true)  // 反转检测白边
        } else {
            return await cropVideoWithFFmpeg(inputPath, outputPath, false) // 正常检测黑边
        }
    }
}

async function delayedDelete(filePaths, delay) {
    await new Promise(resolve => setTimeout(resolve, delay * 1000))
    for (const filePath of filePaths) {
        try {
            if (await fs.stat(filePath).then(() => true).catch(() => false)) {
                await fs.unlink(filePath)
                console.log(`[清理] 已删除临时文件: ${filePath}`)
            }
        } catch (err) {
            console.error(`[清理] 删除失败 ${filePath}: ${err.message}`)
        }
    }
}

// ================= QQ 机器人插件类 =================
export class cropBlackBorder extends plugin {
    constructor() {
        super({
            name: '[裁剪插件]去黑边/去白边/去纯色',
            event: 'message.group',
            priority: 1000,
            rule: [
                { reg: '^#?去黑边$', fnc: 'crop' },
                { reg: '^#?去白边$', fnc: 'cropWhite' },
                { reg: '^#?去纯色$', fnc: 'cropSolidColor' }
            ]
        })
    }

    async extractMediaFromMsg(messageArray, bot) {
        if (!Array.isArray(messageArray)) return []
        return await extractMediaRecursivelyAsync(messageArray, bot)
    }

    async getReplyMedia(e) {
        if (e.getReply) {
            try {
                const rawMsg = await e.getReply()
                if (rawMsg?.message) {
                    return await this.extractMediaFromMsg(rawMsg.message, e.bot)
                }
            } catch (err) {
                console.error('[插件] 通过 getReply 获取消息失败:', err)
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
                            return await this.extractMediaFromMsg(rawMsg.message, e.bot)
                        }
                    }
                }
            } catch (err) {
                console.error('[插件] 通过 source 获取消息失败:', err)
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
            mediaList = await this.extractMediaFromMsg(e.message, e.bot)
        }
        if (mediaList.length === 0) {
            return e.reply(`❌ 请回复或引用一条包含图片/视频的消息，或直接发送带有图片/视频的命令。`, true)
        }

        // 去纯色只支持图片
        if (mode === 'solid') {
            mediaList = mediaList.filter(m => m.type === 'image')
            if (mediaList.length === 0) {
                return e.reply(`❌ “去纯色”功能仅支持图片，不支持视频。`, true)
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
                    failReasons.push(`第 ${idx+1} 个媒体：无法获取 URL`)
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
                        failReasons.push(`第 ${idx+1} 个${isImage ? '图片' : '视频'}处理失败：可能是未检测到边缘或格式不支持。`)
                    }
                } catch (err) {
                    console.error(`[${modeName}] 处理异常:`, err)
                    failReasons.push(`第 ${idx+1} 个媒体处理异常：${err.message}`)
                }
            }

            if (failReasons.length > 0) {
                await e.reply(`❌ 批量处理中发生以下错误：\n${failReasons.map((r,i)=>`${i+1}. ${r}`).join('\n')}`, true)
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
                    console.error(`[${modeName}] 合并转发失败，回退逐条发送:`, forwardErr)
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