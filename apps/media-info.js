import path from 'path'
import {
  isHttpUrl,
  isLikelyImageUrl,
  normalizeForApi,
  downloadMediaToTemp,
  cleanupTempFile,
  getNameWithoutExtension,
  formatSizeMB,
  formatAudioDuration,
  formatAudioBitrate,
  formatSampleRate,
  formatChannels,
  formatVideoDuration,
  formatVideoBitrate,
  getSegField,
  getSegmentFileName,
  getAudioInfoByFfprobe,
  getImageInfoByFfprobe,
  getVideoInfoByFfprobe,
} from './utils.js'

const audioExtensions = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'opus', 'wma', 'ape', 'amr', 'silk', 'weba', 'mpga', 'aif', 'aiff']
const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'ico', 'tiff']
const videoExtensions = ['mp4', 'avi', 'mkv', 'mov', 'flv', 'wmv', 'webm', 'm4v', '3gp']

export class mediaInfo extends plugin {
  constructor() {
    super({
      name: '[ffmpeg-plugin]媒体信息',
      event: 'message',
      priority: 1000,
      rule: [
        { reg: '^#?音频信息$', fnc: 'audioInfoHandler' },
        { reg: '^#?图片信息$', fnc: 'imageInfoHandler' },
        { reg: '^#?视频信息$', fnc: 'videoInfoHandler' }
      ]
    })
  }

  async getReplyMsg(e) {
    if (e.getReply) {
      try {
        const rawMessage = await e.getReply()
        if (rawMessage?.message) return rawMessage
      } catch (error) {
        logger.error(`[ffmpeg-plugin] 通过 getReply 获取消息失败: ${error}`)
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
        logger.error(`[ffmpeg-plugin] 通过 source 获取消息失败: ${error}`)
      }
    }
    return null
  }

  async replyWithForward(e, message, nicknameSuffix) {
    try {
      const botInfo = e.bot || {}
      const botUserId = botInfo.uin || (e.self_id || 10000)
      const botNickname = botInfo.nickname || (nicknameSuffix + '助手')
      if (e.group) {
        const forwardMsg = [{
          message: message,
          nickname: botNickname,
          user_id: botUserId,
        }]
        const forward = await e.group.makeForwardMsg(forwardMsg)
        await e.reply(forward)
      } else {
        await e.reply(message, true)
      }
    } catch (forwardErr) {
      logger.error('[ffmpeg-plugin] 创建合并转发消息失败:', forwardErr)
      await e.reply(message, true)
    }
  }

  async _getMediaUrl(segment, e) {
    const candidates = [
      getSegField(segment, 'url'),
      getSegField(segment, 'file'),
      getSegField(segment, 'src'),
      getSegField(segment, 'origin'),
    ]
    for (const candidate of candidates) {
      if (isHttpUrl(candidate)) return candidate
    }

    const target = e[e.isGroup ? 'group' : 'friend']
    const segPayload = normalizeForApi(segment)

    // 视频：走 ICQQ 发包（对应 getNTVideoUrl）
    if (segment.type === 'video') {
      // 消息段直链（过滤缩略图）
      for (const candidate of candidates) {
        if (isHttpUrl(candidate) && !isLikelyImageUrl(candidate)) return candidate
      }

      const fid = getSegField(segment, 'fid')
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
            } catch (e) { /* ignore */ }
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
            if (isHttpUrl(url)) return url
          }
        } catch (err) {
          logger.warn(`[ffmpeg-plugin] ICQQ 发包获取视频直链失败: ${err.message}`)
        }
      }

      if (fid && target?.getFileUrl) {
        try {
          const url = await target.getFileUrl(fid)
          if (isHttpUrl(url) && !isLikelyImageUrl(url)) return url
        } catch (err) {
          logger.warn(`[ffmpeg-plugin] getFileUrl 获取视频失败: ${err.message}`)
        }
      }

      throw new Error('无法获取视频下载直链')
    }

    // 图片/音频：原有逻辑
    if (target?.getPicUrl && segment.type === 'image') {
      try {
        const url = await target.getPicUrl(segPayload)
        if (isHttpUrl(url)) return url
      } catch (err) {
        logger.warn(`[ffmpeg-plugin] 通过 getPicUrl 获取下载链接失败: ${err.message}`)
      }
    }

    if (target?.getPttUrl && (segment.type === 'record' || segment.type === 'audio')) {
      try {
        const url = await target.getPttUrl(segPayload)
        if (isHttpUrl(url)) return url
      } catch (err) {
        logger.warn(`[ffmpeg-plugin] 通过 getPttUrl 获取下载链接失败: ${err.message}`)
      }
    }

    const fid = getSegField(segment, 'fid')
    if (fid && target?.getFileUrl) {
      try {
        const url = await target.getFileUrl(fid)
        if (isHttpUrl(url)) return url
      } catch (err) {
        logger.warn(`[ffmpeg-plugin] 通过 getFileUrl 获取下载链接失败: ${err.message}`)
      }
    }

    throw new Error('无法获取可下载直链（需要 http/https url）')
  }

  _getFileExtension(segment) {
    const nameCandidates = [
      getSegField(segment, 'filename'),
      getSegField(segment, 'file_name'),
      getSegField(segment, 'name'),
      getSegField(segment, 'title'),
      getSegField(segment, 'file'),
      getSegField(segment, 'url'),
    ]
    for (const candidate of nameCandidates) {
      if (typeof candidate !== 'string' || !candidate.trim()) continue
      let source = candidate
      if (/^https?:\/\//i.test(source)) {
        try { source = new URL(source).pathname } catch (e) { source = source.split('?')[0] }
      }
      const ext = path.extname(source).toLowerCase().slice(1)
      if (ext) return ext
    }
    return null
  }

  extractAudiosFromMsg(messageArray) {
    if (!Array.isArray(messageArray)) return []
    return messageArray.filter(seg => {
      if (seg.type === 'audio' || seg.type === 'record') return true
      if (seg.type === 'file') {
        const data = seg?.data || {}
        if (data.file_type === 'audio') return true
        if (typeof data.mime === 'string' && data.mime.toLowerCase().startsWith('audio/')) return true
        if (typeof data.contentType === 'string' && data.contentType.toLowerCase().startsWith('audio/')) return true
        const ext = this._getFileExtension(seg)
        return ext && audioExtensions.includes(ext)
      }
      return false
    })
  }

  async detectAudioFilesByProbe(messageArray, e) {
    if (!Array.isArray(messageArray)) return []
    const fileSegments = messageArray.filter(seg => seg?.type === 'file')
    const detected = []
    for (const seg of fileSegments) {
      let tempFilePath = null
      try {
        const url = await this._getMediaUrl(seg, e)
        tempFilePath = await downloadMediaToTemp(url)
        await getAudioInfoByFfprobe(tempFilePath)
        detected.push(seg)
      } catch (err) {
        // not an audio file, skip
      } finally {
        await cleanupTempFile(tempFilePath)
      }
    }
    return detected
  }

  extractImagesFromMsg(messageArray) {
    if (!Array.isArray(messageArray)) return []
    return messageArray.filter(seg => {
      if (seg.type === 'image') return true
      if (seg.type === 'file') {
        const ext = this._getFileExtension(seg)
        return ext && imageExtensions.includes(ext)
      }
      return false
    })
  }

  extractVideosFromMsg(messageArray) {
    if (!Array.isArray(messageArray)) return []
    return messageArray.filter(seg => {
      if (seg.type === 'video') return true
      if (seg.type === 'file') {
        const ext = this._getFileExtension(seg)
        return ext && videoExtensions.includes(ext)
      }
      return false
    })
  }

  getDisplayName(segment, defaultPrefix, idx) {
    const nameCandidates = [
      getSegField(segment, 'filename'),
      getSegField(segment, 'file_name'),
      getSegField(segment, 'name'),
      getSegField(segment, 'title'),
    ]
    for (const name of nameCandidates) {
      if (typeof name === 'string' && name.trim()) return name.trim()
    }
    const file = getSegField(segment, 'file')
    if (typeof file === 'string') {
      const base = path.basename(file)
      if (base && base !== '/' && base !== '\\') return base
    }
    const url = getSegField(segment, 'url')
    if (typeof url === 'string') {
      try {
        const urlBase = path.basename(url.split('?')[0])
        if (urlBase && urlBase.length > 0 && urlBase !== '/') return decodeURIComponent(urlBase)
      } catch (e) {}
    }
    return `${defaultPrefix}_${idx + 1}`
  }

  // ========== 音频信息处理 ==========
  async audioInfoHandler(e) {
    let audios = []

    const replyMsg = await this.getReplyMsg(e)
    if (replyMsg && replyMsg.message) {
      audios = this.extractAudiosFromMsg(replyMsg.message)
      if (audios.length === 0) audios = await this.detectAudioFilesByProbe(replyMsg.message, e)
    }
    if (audios.length === 0 && e.message) {
      audios = this.extractAudiosFromMsg(e.message)
      if (audios.length === 0) audios = await this.detectAudioFilesByProbe(e.message, e)
    }
    if (audios.length === 0) {
      return e.reply('❌ 请回复或引用一条包含音频的消息，或直接发送带有音频的命令。', true)
    }

    const results = []
    for (let idx = 0; idx < audios.length; idx++) {
      const audio = audios[idx]
      let url
      try {
        url = await this._getMediaUrl(audio, e)
      } catch (err) {
        results.push(`❌ 音频 ${this.getDisplayName(audio, '音频', idx)}：${err.message}`)
        continue
      }

      const fullDisplayName = this.getDisplayName(audio, '音频', idx)
      const displayNameNoExt = getNameWithoutExtension(fullDisplayName)
      let fileSizeBytes = parseInt(audio.data?.file_size)
      if (isNaN(fileSizeBytes)) fileSizeBytes = null

      let tempFilePath = null
      try {
        tempFilePath = await downloadMediaToTemp(url)
        const info = await getAudioInfoByFfprobe(tempFilePath)
        const finalSize = info.size || fileSizeBytes || 0
        const sizeMB = formatSizeMB(finalSize)

        const lines = [
          `文件名：${displayNameNoExt}`,
          `类型：${info.format}`,
          `时长：${formatAudioDuration(info.duration)}`,
          `比特率：${formatAudioBitrate(info.bitrate)}`,
          `采样率：${formatSampleRate(info.sampleRate)}`,
          `声道：${formatChannels(info.channels)}`,
          `大小：${sizeMB}`,
          `URL：${url}`
        ]
        results.push(lines.join('\n'))
      } catch (err) {
        logger.error(`[ffmpeg-plugin] 处理音频失败: ${err.message}`)
        results.push(`❌ 音频 ${displayNameNoExt} 处理失败：${err.message}`)
      } finally {
        await cleanupTempFile(tempFilePath)
      }
    }

    await this.replyWithForward(e, results.join('\n\n----------------\n\n'), '音频信息')
  }

  formatFrameDuration(fps) {
    if (!fps || fps <= 0) return null
    const secondsPerFrame = 1 / fps
    let formatted = secondsPerFrame.toFixed(4).replace(/\.?0+$/, '')
    if (formatted === '' || formatted === '.') formatted = '0'
    return `${formatted} 秒`
  }

  // ========== 图片信息处理 ==========
  async imageInfoHandler(e) {
    let images = []

    const replyMsg = await this.getReplyMsg(e)
    if (replyMsg && replyMsg.message) images = this.extractImagesFromMsg(replyMsg.message)
    if (images.length === 0 && e.message) images = this.extractImagesFromMsg(e.message)
    if (images.length === 0) {
      return e.reply('❌ 请回复或引用一条包含图片的消息，或直接发送带有图片的命令。', true)
    }

    const results = []
    for (let idx = 0; idx < images.length; idx++) {
      const img = images[idx]
      let url
      try {
        url = await this._getMediaUrl(img, e)
      } catch (err) {
        results.push(`❌ 图片 ${this.getDisplayName(img, '图片', idx)}：${err.message}`)
        continue
      }

      const fullDisplayName = this.getDisplayName(img, '图片', idx)
      const displayNameNoExt = getNameWithoutExtension(fullDisplayName)
      let fileSizeBytes = parseInt(img.data?.file_size)
      if (isNaN(fileSizeBytes)) fileSizeBytes = null

      let tempFilePath = null
      try {
        tempFilePath = await downloadMediaToTemp(url)
        const info = await getImageInfoByFfprobe(tempFilePath)
        const finalSize = info.size || fileSizeBytes || 0
        const sizeMB = formatSizeMB(finalSize)

        const lines = [
          `文件名：${displayNameNoExt}`,
          `类型：${info.format}`,
          `大小：${sizeMB}`,
          `分辨率：${info.width} x ${info.height}`
        ]

        if (info.format === 'GIF') {
          if (info.frames !== null) lines.push(`帧数：${info.frames} 帧`)
          if (info.fps !== null && info.fps > 0) {
            lines.push(`帧率：${info.fps.toFixed(2)} fps`)
            const frameDuration = this.formatFrameDuration(info.fps)
            if (frameDuration) lines.push(`帧时长：${frameDuration}`)
          }
        }
        lines.push(`URL：${url}`)
        results.push(lines.join('\n'))
      } catch (err) {
        logger.error(`[ffmpeg-plugin] 处理图片失败: ${err.message}`)
        results.push(`❌ 图片 ${displayNameNoExt} 处理失败：${err.message}`)
      } finally {
        await cleanupTempFile(tempFilePath)
      }
    }

    await this.replyWithForward(e, results.join('\n\n----------------\n\n'), '图片信息')
  }

  // ========== 视频信息处理 ==========
  async videoInfoHandler(e) {
    let videos = []

    const replyMsg = await this.getReplyMsg(e)
    if (replyMsg && replyMsg.message) videos = this.extractVideosFromMsg(replyMsg.message)
    if (videos.length === 0 && e.message) videos = this.extractVideosFromMsg(e.message)
    if (videos.length === 0) {
      return e.reply('❌ 请回复或引用一条包含视频的消息，或直接发送带有视频的命令。', true)
    }

    const results = []
    for (let idx = 0; idx < videos.length; idx++) {
      const video = videos[idx]
      let url
      try {
        url = await this._getMediaUrl(video, e)
      } catch (err) {
        results.push(`❌ 视频 ${this.getDisplayName(video, '视频', idx)}：${err.message}`)
        continue
      }

      const fullDisplayName = this.getDisplayName(video, '视频', idx)
      const displayNameNoExt = getNameWithoutExtension(fullDisplayName)

      let fallbackExt = null
      const fileField = getSegField(video, 'file')
      if (fileField) {
        const base = path.basename(fileField)
        const ext = path.extname(base)
        if (ext && ext !== '.') fallbackExt = ext
      }

      let fileSizeBytes = parseInt(getSegField(video, 'file_size'))
      if (isNaN(fileSizeBytes)) fileSizeBytes = null

      let tempFilePath = null
      try {
        tempFilePath = await downloadMediaToTemp(url, fallbackExt)
        const info = await getVideoInfoByFfprobe(tempFilePath)
        const finalSize = info.size || fileSizeBytes || 0
        const sizeMB = formatSizeMB(finalSize)

        const lines = [
          `文件名：${displayNameNoExt}`,
          `媒体格式：${info.container}`,
          `分辨率：${info.width} x ${info.height}`,
          `时长：${formatVideoDuration(info.durationSec)}`,
          `视频编码：${info.videoCodec}`
        ]
        if (info.fps) lines.push(`帧率：${info.fps} fps`)
        if (info.videoBitrate) lines.push(`视频码率：${formatVideoBitrate(info.videoBitrate)}`)
        if (info.audioCodec) {
          lines.push(`音频编码：${info.audioCodec}`)
          if (info.sampleRate) lines.push(`采样率：${info.sampleRate}`)
          if (info.channels) lines.push(`声道：${info.channels}`)
          if (info.audioBitrate) lines.push(`音频码率：${formatVideoBitrate(info.audioBitrate)}`)
        }
        if (info.totalBitrate) lines.push(`总码率：${formatVideoBitrate(info.totalBitrate)}`)
        lines.push(`文件大小：${sizeMB}`)
        lines.push(`URL：${url}`)

        results.push(lines.join('\n'))
      } catch (err) {
        logger.error(`[ffmpeg-plugin] 处理视频失败: ${err.message}`)
        if (err.message.includes('未找到视频流')) {
          results.push(`❌ 视频 ${displayNameNoExt} 可能不是视频文件（或为 GIF 动图），请使用 #图片信息 命令。`)
        } else {
          results.push(`❌ 视频 ${displayNameNoExt} 处理失败：${err.message}`)
        }
      } finally {
        await cleanupTempFile(tempFilePath)
      }
    }

    await this.replyWithForward(e, results.join('\n\n----------------\n\n'), '视频信息')
  }
}
