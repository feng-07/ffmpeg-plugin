import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import archiver from 'archiver'
import {
  isHttpUrl,
  isLikelyImageUrl,
  normalizeForApi,
  getSegField,
  getSegmentFileName,
  getSegmentExt,
  sanitizeSendFileName,
  downloadFile,
  downloadMediaToTemp,
  ensureTempDir,
  getTempFilePath,
  cleanupTempFile,
  removePath,
  formatSizeMB,
  getImageFormatByFfprobe,
  decomposeGifToPngs,
} from './utils.js'

const execFileAsync = promisify(execFile)

// 通过 HEAD 请求检查 URL 的 content-type 是否为图片
async function isUrlImageContent(url) {
  try {
    const resp = await axios.head(url, { timeout: 5000 })
    const ct = (resp.headers['content-type'] || '').toLowerCase()
    return ct.startsWith('image/')
  } catch (e) {
    return false
  }
}

const segment = global.segment

const videoExts = ['.mp4', '.mkv', '.avi', '.mov', '.flv', '.webm', '.wmv', '.m4v', '.3gp', '.ts']
const audioExts = ['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.wma', '.ape', '.aiff']

async function packPngsToZip(pngFiles, zipOutputPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipOutputPath)
    const archive = archiver('zip', { zlib: { level: 9 } })
    output.on('close', () => resolve())
    output.on('error', reject)
    archive.on('error', reject)
    archive.pipe(output)
    for (const pngPath of pngFiles) {
      archive.file(pngPath, { name: path.basename(pngPath) })
    }
    archive.finalize()
  })
}

// ================= 主插件类 =================

export class mediaTool extends plugin {
  constructor() {
    super({
      name: '[ffmpeg-plugin]多媒体工具箱',
      dsc: '视频转GIF、GIF分解、GIF打包ZIP、视频转语音、音视频转MP3/FLAC',
      event: 'message',
      priority: 310,
      rule: [
        { reg: /^#(转动图|转gif)$/i, fnc: 'convertToGif' },
        { reg: /^#?(动图分解|gif分解)$/i, fnc: 'decomposeGif' },
        { reg: '^#?(动图打包|gif打包)$', fnc: 'packGifToZip' },
        { reg: '^#转语音$', fnc: 'convertToVoice' },
        { reg: '^#转mp3$', fnc: 'convertToMp3' },
        { reg: '^#转flac$', fnc: 'convertToFlac' }
      ]
    })
  }

  // ================= 消息提取方法 =================

  extractVideoFromMsg(messageArray) {
    if (!Array.isArray(messageArray)) return []
    const videos = messageArray.filter(seg => seg.type === 'video')
    const files = messageArray.filter(seg => seg.type === 'file')
    for (const file of files) {
      const ext = getSegmentExt(file)
      if (videoExts.includes(ext)) videos.push(file)
    }
    return videos
  }

  extractAudioFromMsg(messageArray) {
    if (!Array.isArray(messageArray)) return []
    const audioSegments = messageArray.filter(seg => seg.type === 'audio' || seg.type === 'record')
    const files = messageArray.filter(seg => seg.type === 'file')
    for (const file of files) {
      const fileName = getSegmentFileName(file)
      const ext = path.extname(fileName).toLowerCase()
      if (audioExts.includes(ext)) audioSegments.push(file)
    }
    return audioSegments
  }

  extractImagesFromMsg(messageArray) {
    if (!Array.isArray(messageArray)) return []
    return messageArray.filter(seg => seg.type === 'image')
  }

  async getQuotedMessageRaw(e) {
    if (e.getReply) {
      try {
        const rawMessage = await e.getReply()
        if (rawMessage?.message) return rawMessage
      } catch (error) {
        logger.error(`[多媒体插件] 获取引用消息失败: ${error}`)
      }
    }
    if (e.source) {
      try {
        const target = e[e.isGroup ? 'group' : 'friend']
        if (!target?.getChatHistory) return null
        const seq = e.isGroup ? e.source.seq : (e.source.time ? e.source.time + 1 : undefined)
        if (seq === undefined) return null
        const messages = await target.getChatHistory(seq, 1)
        const rawMessage = messages.pop()
        if (rawMessage?.message) return rawMessage
      } catch (error) {
        logger.error(`[多媒体插件] 通过source获取消息失败: ${error}`)
      }
    }
    return null
  }

  async _getMediaUrl(segment, e) {
    const candidates = [
      getSegField(segment, 'url'),
      getSegField(segment, 'file'),
      getSegField(segment, 'src'),
      getSegField(segment, 'origin')
    ]

    const target = e[e.isGroup ? 'group' : 'friend']
    const segPayload = normalizeForApi(segment)
    const fid = getSegField(segment, 'fid')

    if (segment.type === 'video') {
      // 1. 消息段中的 HTTP 直链（非缩略图）
      for (const candidate of candidates) {
        if (isHttpUrl(candidate)) {
          if (isLikelyImageUrl(candidate)) {
            logger.warn(`[多媒体插件] 视频消息直链疑似图片缩略图，已忽略: ${candidate}`)
            continue
          }
          logger.info(`[多媒体插件] 使用视频消息中的直链`)
          return candidate
        }
      }

      // 2. ICQQ 发包获取视频直链（对应 ICQQ 源码的 getNTVideoUrl）
      //    私聊: OidbSvcTrpcTcp.0x11e9_200 (dm=true)
      //    群聊: OidbSvcTrpcTcp.0x11ea_200 (dm=false)
      if (fid && typeof Bot?.sendOidbSvcTrpcTcp === 'function') {
        try {
          const dm = !e.isGroup
          const info = { 1: { 1: segment.size || 0, 2: segment.md5 || "" }, 2: fid, 3: segment.nt ? 1 : 0 }
          let file = String(segment.file || "")
          if (file.startsWith("protobuf://")) {
            try {
              const { default: pb } = await import("protobufjs")
              const buf = Buffer.from(file.replace("protobuf://", ""), "base64")
              const decoded = pb.decode(buf)
              if (decoded?.[2]?.[1]?.[1]?.[1]) Object.assign(info, decoded[2][1][1][1])
            } catch (e) { /* ignore parse error, use basic info */ }
          }
          const body = {
            1: { 1: { 1: 1, 2: 200 }, 2: dm
              ? { 101: 2, 102: 2, 200: 1, 201: { 1: 2, 2: String(e.sender?.user_id || e.user_id || target.uin) } }
              : { 101: 2, 102: 2, 200: 2, 202: { 1: e.group_id } },
              3: { 1: 2 } },
            3: { 1: info, 2: { 2: { 1: 0, 3: 0 } } }
          }
          const cmd = dm ? 'OidbSvcTrpcTcp.0x11e9_200' : 'OidbSvcTrpcTcp.0x11ea_200'
          const rsp = await Bot.sendOidbSvcTrpcTcp(cmd, body, { message_type: 32 })
          const host = rsp?.[3]?.[3]?.[1]
          const uri = rsp?.[3]?.[3]?.[2]
          const rkey = rsp?.[3]?.[1]
          if (host && uri && rkey) {
            const url = `https://${host}${uri}${rkey}`
            if (isHttpUrl(url)) {
              logger.info(`[多媒体插件] 通过 ICQQ 发包(${dm ? '私聊' : '群聊'})获取视频直链成功`)
              return url
            }
          }
        } catch (err) {
          logger.warn(`[多媒体插件] ICQQ 发包获取视频直链失败: ${err.message}`)
        }
      }

      // 3. getFileUrl
      if (fid && target?.getFileUrl) {
        try {
          const url = await target.getFileUrl(fid)
          if (isHttpUrl(url) && !isLikelyImageUrl(url)) {
            logger.info('[多媒体插件] 通过 getFileUrl 获取视频直链成功')
            return url
          }
          if (isHttpUrl(url)) {
            logger.warn(`[多媒体插件] getFileUrl 返回疑似图片链接，已忽略: ${url}`)
          }
        } catch (err) {
          logger.warn(`[多媒体插件] getFileUrl 获取视频失败: ${err.message}`)
        }
      }

      throw new Error('无法获取可下载视频直链（需要原视频 URL）')
    }

    for (const candidate of candidates) {
      if (isHttpUrl(candidate)) return candidate
    }

    if (target?.getPicUrl && segment.type === 'image') {
      try {
        const url = await target.getPicUrl(segPayload)
        if (isHttpUrl(url)) return url
      } catch (err) {
        logger.warn(`[多媒体插件] getPicUrl 失败: ${err.message}`)
      }
    }

    if (fid && target?.getFileUrl) {
      try {
        const url = await target.getFileUrl(fid)
        if (isHttpUrl(url)) return url
      } catch (err) {
        logger.error(`[多媒体插件] getFileUrl 失败: ${err.message}`)
      }
    }

    if (target?.getPttUrl && (segment.type === 'record' || segment.type === 'audio')) {
      try {
        const url = await target.getPttUrl(segPayload)
        if (isHttpUrl(url)) return url
      } catch (err) {
        logger.warn(`[多媒体插件] getPttUrl 失败: ${err.message}`)
      }
    }

    throw new Error('无法获取可下载直链（需要 http/https url）')
  }

  async getTargetVideo(e) {
    let videoSegments = []
    const quoted = await this.getQuotedMessageRaw(e)
    if (quoted && quoted.message) {
      videoSegments = this.extractVideoFromMsg(quoted.message)
    }
    if (videoSegments.length === 0) {
      videoSegments = this.extractVideoFromMsg(e.message)
    }
    if (videoSegments.length === 0) return null

    const seg = videoSegments[0]
    let fileUrl
    try {
      fileUrl = await this._getMediaUrl(seg, e)
    } catch (err) {
      logger.error(`[多媒体插件] 获取视频链接失败: ${err.message}`)
      return null
    }

    let fileName = getSegmentFileName(seg)
    if (!fileName && fileUrl) {
      fileName = path.basename(fileUrl.split('?')[0])
    }
    if (!fileName || fileName.startsWith('fid:')) fileName = 'video.mp4'

    const sizeRaw = getSegField(seg, 'file_size') || getSegField(seg, 'size')
    const fileSize = sizeRaw ? parseInt(sizeRaw) : null

    return { segment: seg, fileUrl, fileName, fileSize }
  }

  async getTargetAudio(e) {
    let audioSegments = []
    const quoted = await this.getQuotedMessageRaw(e)
    if (quoted && quoted.message) {
      audioSegments = this.extractAudioFromMsg(quoted.message)
    }
    if (audioSegments.length === 0) {
      audioSegments = this.extractAudioFromMsg(e.message)
    }
    if (audioSegments.length === 0) return null

    const seg = audioSegments[0]
    let fileUrl
    try {
      fileUrl = await this._getMediaUrl(seg, e)
    } catch (err) {
      logger.error(`[多媒体插件] 获取音频链接失败: ${err.message}`)
      return null
    }

    let fileName = getSegmentFileName(seg)
    if (!fileName && fileUrl) {
      fileName = path.basename(fileUrl.split('?')[0])
    }
    if (!fileName || fileName.startsWith('fid:')) fileName = 'audio.bin'

    const sizeRaw = getSegField(seg, 'file_size') || getSegField(seg, 'size')
    const fileSize = sizeRaw ? parseInt(sizeRaw) : null

    return { segment: seg, fileUrl, fileName, fileSize }
  }

  async getTargetImage(e) {
    let images = []
    const quoted = await this.getQuotedMessageRaw(e)
    if (quoted && quoted.message) {
      images = this.extractImagesFromMsg(quoted.message)
    }
    if (images.length === 0) {
      images = this.extractImagesFromMsg(e.message)
    }
    if (images.length === 0) return null

    const targetImg = images[0]
    let url
    try {
      url = await this._getMediaUrl(targetImg, e)
    } catch (err) {
      logger.error(`[多媒体插件] 获取图片链接失败: ${err.message}`)
      return null
    }
    return { segment: targetImg, url }
  }

  async getTargetMediaForTranscode(e) {
    const audio = await this.getTargetAudio(e)
    if (audio) return { type: 'audio', ...audio }
    const video = await this.getTargetVideo(e)
    if (video) return { type: 'video', ...video }
    return null
  }

  // ================= FFmpeg 通用 =================

  async runFFmpeg(args, timeoutMs = 120000) {
    logger.info(`[多媒体插件] 执行命令: ffmpeg ${args.join(' ')}`)
    try {
      const { stdout, stderr } = await execFileAsync('ffmpeg', args, { timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024 })
      if (stderr && !stderr.includes('frame=') && !stderr.includes('size=')) {
        logger.warn(`[多媒体插件] stderr: ${stderr.slice(0, 300)}`)
      }
      return { stdout, stderr }
    } catch (err) {
      logger.error(`[多媒体插件] 命令失败: ${err.message}`)
      throw new Error(`FFmpeg处理失败: ${err.stderr || err.message}`)
    }
  }

  async convertToGifFile(inputPath, outputPath) {
    const { stdout: probeStdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', inputPath
    ])
    const probeData = JSON.parse(probeStdout || '{}')
    const videoStream = probeData.streams?.find(s => s.codec_type === 'video')
    if (!videoStream) {
      throw new Error('下载到的文件不是视频（未检测到视频流）')
    }

    const formatName = String(probeData.format?.format_name || '').toLowerCase()
    const codecName = String(videoStream.codec_name || '').toLowerCase()
    if (formatName.includes('image2') || formatName.includes('jpeg_pipe') || codecName === 'mjpeg') {
      throw new Error('下载到的是图片/缩略图而非原视频，请重试或更换消息来源')
    }

    const filter = "fps=12,scale=320:-1:flags=lanczos"
    await this.runFFmpeg(['-i', inputPath, '-vf', filter, '-loop', '0', outputPath, '-y'], 180000)
    return outputPath
  }

  async convertToMp3File(inputPath, outputPath) {
    await this.runFFmpeg(['-i', inputPath, '-c:a', 'libmp3lame', '-q:a', '2', outputPath, '-y'], 120000)
    return outputPath
  }

  async convertToFlacFile(inputPath, outputPath) {
    await this.runFFmpeg(['-i', inputPath, '-c:a', 'flac', outputPath, '-y'], 120000)
    return outputPath
  }

  async sendFileAsMessage(e, filePath, displayName) {
    let stat
    try {
      stat = await fs.promises.stat(filePath)
    } catch (err) {
      throw new Error(`待发送文件不存在: ${filePath}`)
    }
    if (!stat.isFile()) throw new Error(`待发送目标不是文件: ${filePath}`)
    if (stat.size <= 0) throw new Error(`待发送文件为空: ${filePath}`)

    const fallbackExt = path.extname(filePath) || '.bin'
    const safeDisplayName = sanitizeSendFileName(displayName, fallbackExt)
    const fileSizeMB = (stat.size / (1024 * 1024)).toFixed(2)
    logger.info(`[多媒体插件] 准备发送文件: ${safeDisplayName}, 大小 ${fileSizeMB} MB`)

    const maxRetries = 3
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (e.isGroup) {
          if (e.group?.sendFile) {
            await e.group.sendFile(filePath, '/', safeDisplayName)
          } else if (e.group?.fs?.upload) {
            await e.group.fs.upload(filePath, '/', safeDisplayName)
          } else {
            throw new Error('当前群聊环境不支持文件发送/上传')
          }
        } else {
          if (!e.friend?.sendFile) throw new Error('当前适配器不支持文件发送')
          await e.friend.sendFile(filePath, safeDisplayName)
        }
        return true
      } catch (err) {
        if (attempt < maxRetries) {
          logger.warn(`[多媒体插件] 文件发送失败(第${attempt}次)，${attempt * 2}秒后重试: ${err.message}`)
          await new Promise(r => setTimeout(r, attempt * 2000))
        } else {
          throw new Error(`文件发送失败(已重试${maxRetries}次): ${err.message}`)
        }
      }
    }
  }

  // ================= 错误处理（合并转发优先） =================

  async sendErrorAsForward(e, errorMessage) {
    try {
      const forwardNodes = [{
        user_id: e.bot.uin || e.self_id || 10000,
        nickname: '小助手',
        message: `❌ ${errorMessage}`
      }]
      const forward = e.isGroup
        ? await e.group.makeForwardMsg(forwardNodes)
        : await e.friend.makeForwardMsg(forwardNodes)
      await e.reply(forward)
      return true
    } catch (err) {
      logger.warn(`[多媒体插件] 合并转发错误消息失败，降级为普通消息: ${err.message}`)
      await e.reply(`❌ ${errorMessage}`, true)
      return false
    }
  }

  // ================= 功能实现 =================

  async convertToGif(e) {
    let inputTempPath = null, outputTempPath = null
    try {
      await e.reply('⏳ 正在将视频转为GIF，请稍等...')
      const video = await this.getTargetVideo(e)
      if (!video) {
        await this.sendErrorAsForward(e, '请回复或引用一条视频消息，然后发送 #转动图 或 #转gif')
        return true
      }
      logger.info(`[GIF转换] 开始处理: ${video.fileName}`)

      inputTempPath = getTempFilePath(path.extname(video.fileName) || '.mp4')
      await downloadFile(video.fileUrl, inputTempPath)
      const stat = await fs.promises.stat(inputTempPath)
      logger.info(`[GIF转换] 下载完成，大小: ${formatSizeMB(stat.size)}`)

      outputTempPath = getTempFilePath('.gif')
      await this.convertToGifFile(inputTempPath, outputTempPath)
      const outStat = await fs.promises.stat(outputTempPath)
      logger.info(`[GIF转换] GIF生成完成，大小: ${formatSizeMB(outStat.size)}`)
      await e.reply(segment.image(outputTempPath))
    } catch (err) {
      logger.error(`[GIF转换] 失败: ${err.message}`)
      await this.sendErrorAsForward(e, `转动图失败: ${err.message}`)
    } finally {
      if (inputTempPath && !String(inputTempPath).startsWith('protobuf://')) {
        await cleanupTempFile(inputTempPath)
      }
      await cleanupTempFile(outputTempPath)
    }
    return true
  }

  async decomposeGif(e) {
    let tempGifPath = null, outputDir = null
    try {
      const targetImage = await this.getTargetImage(e)
      if (!targetImage) {
        await this.sendErrorAsForward(e, '请回复或引用一条包含 GIF 图片的消息，或直接发送带有 GIF 的命令。')
        return true
      }
      tempGifPath = await downloadMediaToTemp(targetImage.url)
      const format = await getImageFormatByFfprobe(tempGifPath)
      if (format !== 'GIF') {
        await this.sendErrorAsForward(e, `该图片格式为 ${format}，仅支持 GIF 动图分解。`)
        return true
      }
      const uniqueId = `${Date.now()}_${Math.random().toString(36).slice(2)}`
      outputDir = path.join(await ensureTempDir(), 'decompose', uniqueId)
      const maxFrames = 100
      const pngFiles = await decomposeGifToPngs(tempGifPath, outputDir, maxFrames)
      const totalFrames = pngFiles.length

      const botUin = e.bot.uin || e.self_id || 10000
      const forwardMessages = [
        { user_id: botUin, nickname: '小助手', message: '⏳ 正在下载图片并检测格式...' },
        { user_id: botUin, nickname: '小助手', message: `⏳ 正在分解 GIF...\n温馨提醒（最多 ${maxFrames} 帧）` }
      ]

      for (let i = 0; i < totalFrames; i++) {
        const base64Data = await fs.promises.readFile(pngFiles[i], 'base64')
        forwardMessages.push({
          user_id: botUin,
          nickname: '动图分解助手',
          message: [`第 ${i + 1} 帧\n`, segment.image(`base64://${base64Data}`)]
        })
      }

      forwardMessages.push({
        user_id: botUin,
        nickname: '小助手',
        message: `✅ 分解完成，共 ${totalFrames} 帧。`
      })

      try {
        const forward = e.isGroup
          ? await e.group.makeForwardMsg(forwardMessages)
          : await e.friend.makeForwardMsg(forwardMessages)
        await e.reply(forward)
      } catch (forwardErr) {
        logger.error('[多媒体插件] 合并转发失败，降级为逐张发送:', forwardErr)
        await e.reply('⏳ 正在下载图片并检测格式...\n⏳ 正在分解 GIF...\n温馨提醒（最多 100 帧）', true)
        for (let i = 0; i < totalFrames; i++) {
          const base64Data = await fs.promises.readFile(pngFiles[i], 'base64')
          await e.reply([`第 ${i + 1} 帧`, segment.image(`base64://${base64Data}`)])
          await new Promise(r => setTimeout(r, 500))
        }
        await e.reply(`✅ 分解完成，共 ${totalFrames} 帧。`, true)
      }
    } catch (err) {
      logger.error(`[多媒体插件] 动图分解失败: ${err.message}`)
      await this.sendErrorAsForward(e, `处理失败：${err.message}`)
    } finally {
      await cleanupTempFile(tempGifPath)
      if (outputDir) await removePath(outputDir)
    }
  }

  async packGifToZip(e) {
    let tempGifPath = null, outputDir = null, zipFilePath = null
    let sendSuccess = false
    try {
      const targetImage = await this.getTargetImage(e)
      if (!targetImage) {
        await this.sendErrorAsForward(e, '请回复或引用一条包含 GIF 图片的消息，或直接发送带有 GIF 的命令。')
        return true
      }
      tempGifPath = await downloadMediaToTemp(targetImage.url)
      const format = await getImageFormatByFfprobe(tempGifPath)
      if (format !== 'GIF') {
        await this.sendErrorAsForward(e, `该图片格式为 ${format}，仅支持 GIF 动图打包。`)
        return true
      }
      const uniqueId = `${Date.now()}_${Math.random().toString(36).slice(2)}`
      outputDir = path.join(await ensureTempDir(), 'decompose', uniqueId)
      const maxFrames = 300
      const pngFiles = await decomposeGifToPngs(tempGifPath, outputDir, maxFrames)
      zipFilePath = path.join(await ensureTempDir(), `gif_frames_${uniqueId}.zip`)
      await packPngsToZip(pngFiles, zipFilePath)
      const displayName = `gif_frames_${uniqueId}.zip`
      await this.sendFileAsMessage(e, zipFilePath, displayName)
      sendSuccess = true
    } catch (err) {
      logger.error(`[多媒体插件] 动图打包失败: ${err.message}`)
      await this.sendErrorAsForward(e, `处理失败：${err.message}`)
    } finally {
      await cleanupTempFile(tempGifPath)
      if (outputDir) await removePath(outputDir)
      if (zipFilePath && sendSuccess) {
        await cleanupTempFile(zipFilePath)
      } else if (zipFilePath && !sendSuccess) {
        logger.warn(`[动图打包] 发送失败，保留输出文件用于排查: ${zipFilePath}`)
      }
    }
  }

  async convertToVoice(e) {
    let inputTempPath = null, outputTempPath = null
    try {
      await e.reply('⏳ 正在将视频转为语音，请稍等...')
      const video = await this.getTargetVideo(e)
      if (!video) {
        await this.sendErrorAsForward(e, '请回复或引用一条视频消息，然后发送 #转语音')
        return true
      }
      logger.info(`[转语音] 开始处理: ${video.fileName}`)
      inputTempPath = getTempFilePath(path.extname(video.fileName) || '.mp4')
      await downloadFile(video.fileUrl, inputTempPath)
      const stat = await fs.promises.stat(inputTempPath)
      logger.info(`[转语音] 下载完成，大小: ${formatSizeMB(stat.size)}`)
      outputTempPath = getTempFilePath('.mp3')
      await this.convertToMp3File(inputTempPath, outputTempPath)
      const outStat = await fs.promises.stat(outputTempPath)
      logger.info(`[转语音] MP3生成完成，大小: ${formatSizeMB(outStat.size)}`)
      await e.reply(segment.record(outputTempPath))
      logger.info(`[转语音] MP3语音消息发送成功`)
    } catch (err) {
      logger.error(`[转语音] 失败: ${err.message}`)
      await this.sendErrorAsForward(e, `转语音失败: ${err.message}`)
    } finally {
      await cleanupTempFile(inputTempPath)
      await cleanupTempFile(outputTempPath)
    }
    return true
  }

  async convertToMp3(e) {
    let inputTempPath = null, outputTempPath = null
    let sendSuccess = false
    try {
      await e.reply('⏳ 正在将音视频转为 MP3 文件，请稍等...')
      const media = await this.getTargetMediaForTranscode(e)
      if (!media) {
        await this.sendErrorAsForward(e, '请回复或引用一条音视频消息，然后发送 #转mp3')
        return true
      }
      logger.info(`[转MP3] 开始处理: ${media.fileName}`)
      inputTempPath = getTempFilePath(path.extname(media.fileName) || '.bin')
      await downloadFile(media.fileUrl, inputTempPath)
      const stat = await fs.promises.stat(inputTempPath)
      logger.info(`[转MP3] 下载完成，大小: ${formatSizeMB(stat.size)}`)
      outputTempPath = getTempFilePath('.mp3')
      await this.convertToMp3File(inputTempPath, outputTempPath)
      const outStat = await fs.promises.stat(outputTempPath)
      logger.info(`[转MP3] MP3 生成完成，大小: ${formatSizeMB(outStat.size)}`)
      const outputFileName = path.basename(media.fileName, path.extname(media.fileName)) + '.mp3'
      await this.sendFileAsMessage(e, outputTempPath, outputFileName)
      sendSuccess = true
    } catch (err) {
      logger.error(`[转MP3] 失败: ${err.message}`)
      await this.sendErrorAsForward(e, `转 MP3 失败: ${err.message}`)
    } finally {
      await cleanupTempFile(inputTempPath)
      if (outputTempPath && sendSuccess) {
        await cleanupTempFile(outputTempPath)
      } else if (outputTempPath && !sendSuccess) {
        logger.warn(`[转MP3] 发送失败，保留输出文件用于排查: ${outputTempPath}`)
      }
    }
    return true
  }

  async convertToFlac(e) {
    let inputTempPath = null, outputTempPath = null
    let sendSuccess = false
    try {
      await e.reply('⏳ 正在将音视频转为 FLAC 文件，请稍等...')
      const media = await this.getTargetMediaForTranscode(e)
      if (!media) {
        await this.sendErrorAsForward(e, '请回复或引用一条音视频消息，然后发送 #转flac')
        return true
      }
      logger.info(`[转FLAC] 开始处理: ${media.fileName}`)
      inputTempPath = getTempFilePath(path.extname(media.fileName) || '.bin')
      await downloadFile(media.fileUrl, inputTempPath)
      const stat = await fs.promises.stat(inputTempPath)
      logger.info(`[转FLAC] 下载完成，大小: ${formatSizeMB(stat.size)}`)
      outputTempPath = getTempFilePath('.flac')
      await this.convertToFlacFile(inputTempPath, outputTempPath)
      const outStat = await fs.promises.stat(outputTempPath)
      logger.info(`[转FLAC] FLAC 生成完成，大小: ${formatSizeMB(outStat.size)}`)
      const outputFileName = path.basename(media.fileName, path.extname(media.fileName)) + '.flac'
      await this.sendFileAsMessage(e, outputTempPath, outputFileName)
      sendSuccess = true
    } catch (err) {
      logger.error(`[转FLAC] 失败: ${err.message}`)
      await this.sendErrorAsForward(e, `转 FLAC 失败: ${err.message}`)
    } finally {
      await cleanupTempFile(inputTempPath)
      if (outputTempPath && sendSuccess) {
        await cleanupTempFile(outputTempPath)
      } else if (outputTempPath && !sendSuccess) {
        logger.warn(`[转FLAC] 发送失败，保留输出文件用于排查: ${outputTempPath}`)
      }
    }
    return true
  }
}
