import { exec } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import { createWriteStream } from 'fs'
import path from 'path'
import os from 'os'
import axios from 'axios'

const execPromise = promisify(exec)

// ==================== 通用辅助函数 ====================

async function downloadMediaToTemp(url, fallbackExt = null) {
    const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'stream',
        timeout: 60000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity
    })
    
    let ext = fallbackExt
    if (!ext) {
        try {
            const urlObj = new URL(url)
            const pathname = urlObj.pathname
            ext = path.extname(pathname)
            if (ext && ext !== '.') {
                ext = ext.split('?')[0]
                ext = ext.replace(/[^a-zA-Z0-9.]/g, '')
                if (!ext.startsWith('.')) ext = '.' + ext
            }
        } catch (e) {}
        if (!ext || ext === '.') ext = '.tmp'
    }
    
    const tempFile = path.join(os.tmpdir(), `media_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`)
    const writer = createWriteStream(tempFile)
    response.data.pipe(writer)
    await new Promise((resolve, reject) => {
        writer.on('finish', resolve)
        writer.on('error', reject)
    })
    return tempFile
}

function getNameWithoutExtension(fullName) {
    const extIndex = fullName.lastIndexOf('.')
    if (extIndex > 0) {
        return fullName.substring(0, extIndex)
    }
    return fullName
}

function formatSizeMB(bytes) {
    if (!bytes || bytes <= 0) return '未知'
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
}

function formatAudioDuration(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return '未知'
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const secs = Math.floor(seconds % 60)
    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`
}

function formatAudioBitrate(bitrate) {
    if (!bitrate || bitrate <= 0) return '未知'
    const kbps = Math.round(bitrate / 1000)
    return `${kbps} kbps`
}

function formatSampleRate(sampleRate) {
    if (!sampleRate || sampleRate <= 0) return '未知'
    if (sampleRate >= 1000) {
        return `${(sampleRate / 1000).toFixed(1)} kHz`
    }
    return `${sampleRate} Hz`
}

function formatChannels(channels) {
    if (channels === 1) return '单声道'
    if (channels === 2) return '立体声'
    if (channels > 2) return `${channels} 声道`
    return '未知'
}

function formatVideoDuration(seconds) {
    if (!seconds || seconds <= 0) return '0 秒'
    const hrs = Math.floor(seconds / 3600)
    const mins = Math.floor((seconds % 3600) / 60)
    const secs = Math.floor(seconds % 60)
    if (hrs > 0) {
        return `${hrs} 小时 ${mins} 分 ${secs} 秒`
    } else if (mins > 0) {
        return `${mins} 分 ${secs} 秒`
    } else {
        return `${secs} 秒`
    }
}

function formatVideoBitrate(bps) {
    if (!bps || bps <= 0) return '未知'
    if (bps >= 1_000_000) return (bps / 1_000_000).toFixed(2) + ' Mbps'
    if (bps >= 1000) return (bps / 1000).toFixed(2) + ' kbps'
    return bps + ' bps'
}

function isHttpUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url.trim())
}

function normalizeForApi(input) {
    return JSON.parse(JSON.stringify(input, (_, value) =>
        typeof value === 'bigint' ? value.toString() : value
    ))
}

// ==================== ffprobe 信息获取函数 ====================

async function getAudioInfoByFfprobe(filePath) {
    try {
        const { stdout } = await execPromise(
            `ffprobe -v quiet -print_format json -show_streams -show_format "${filePath}"`
        )
        const data = JSON.parse(stdout)
        const audioStream = data.streams?.find(s => s.codec_type === 'audio')
        if (!audioStream) throw new Error('未找到音频流')

        let format = audioStream.codec_name?.toUpperCase() || '未知'
        const formatMap = {
            'MP3': 'MP3', 'MP2': 'MP2', 'AAC': 'AAC', 'FLAC': 'FLAC',
            'ALAC': 'ALAC', 'WMA': 'WMA', 'OGG': 'OGG', 'OPUS': 'Opus',
            'VORBIS': 'Vorbis', 'PCM_S16LE': 'WAV', 'PCM_S16BE': 'WAV',
            'PCM_U8': 'WAV', 'PCM_S24LE': 'WAV'
        }
        if (formatMap[format]) format = formatMap[format]
        else if (format.startsWith('PCM')) format = 'WAV'

        let duration = parseFloat(audioStream.duration)
        if (isNaN(duration) && data.format?.duration) duration = parseFloat(data.format.duration)
        if (isNaN(duration)) duration = 0

        let bitrate = parseInt(audioStream.bit_rate)
        if (isNaN(bitrate) && data.format?.bit_rate) bitrate = parseInt(data.format.bit_rate)
        if (isNaN(bitrate)) bitrate = 0

        let sampleRate = parseInt(audioStream.sample_rate)
        if (isNaN(sampleRate)) sampleRate = 0

        let channels = parseInt(audioStream.channels)
        if (isNaN(channels)) channels = 0

        const fileSize = parseInt(data.format?.size) || (await fs.stat(filePath)).size
        return { format, duration, bitrate, sampleRate, channels, size: fileSize }
    } catch (err) {
        throw new Error(`ffprobe 分析失败: ${err.message}`)
    }
}

async function getImageInfoByFfprobe(filePath) {
    try {
        const { stdout } = await execPromise(
            `ffprobe -v quiet -print_format json -show_streams -show_format "${filePath}"`
        )
        const data = JSON.parse(stdout)
        const videoStream = data.streams?.find(s => s.codec_type === 'video')
        if (!videoStream) throw new Error('未找到视频/图像流')

        let format = videoStream.codec_name?.toUpperCase() || '未知'
        if (format === 'JPEG') format = 'JPG'
        else if (format === 'PNG') format = 'PNG'
        else if (format === 'GIF') format = 'GIF'
        else if (format === 'WEBP') format = 'WEBP'

        const width = videoStream.width || 0
        const height = videoStream.height || 0

        let frames = null, fps = null
        if (format === 'GIF') {
            frames = videoStream.nb_frames
            if (!frames && videoStream.avg_frame_rate) {
                const [num, den] = videoStream.avg_frame_rate.split('/')
                const duration = parseFloat(videoStream.duration)
                if (!isNaN(duration) && num && den) {
                    frames = Math.round(duration * (parseInt(num) / parseInt(den)))
                }
            }
            const frameRateStr = videoStream.r_frame_rate || videoStream.avg_frame_rate
            if (frameRateStr) {
                const [num, den] = frameRateStr.split('/')
                if (num && den && parseInt(den) !== 0) {
                    fps = parseFloat(num) / parseFloat(den)
                } else if (num && !den) {
                    fps = parseFloat(num)
                }
            }
        }

        const fileSize = parseInt(data.format?.size) || (await fs.stat(filePath)).size
        return { format, width, height, frames, fps, size: fileSize }
    } catch (err) {
        throw new Error(`ffprobe 分析失败: ${err.message}`)
    }
}

async function getVideoInfoByFfprobe(filePath) {
    try {
        const { stdout } = await execPromise(
            `ffprobe -v quiet -print_format json -show_streams -show_format "${filePath}"`
        )
        const data = JSON.parse(stdout)
        const videoStream = data.streams?.find(s => s.codec_type === 'video')
        if (!videoStream) throw new Error('未找到视频流')

        const container = data.format?.format_name?.split(',')[0]?.toUpperCase() || '未知'
        const videoCodec = videoStream.codec_name?.toUpperCase() || '未知'
        const width = videoStream.width || 0
        const height = videoStream.height || 0

        let durationSec = parseFloat(videoStream.duration || data.format?.duration)
        if (isNaN(durationSec)) durationSec = 0

        let fps = null
        const frameRateStr = videoStream.r_frame_rate || videoStream.avg_frame_rate
        if (frameRateStr) {
            const [num, den] = frameRateStr.split('/')
            if (num && den && parseInt(den) !== 0) {
                fps = parseFloat(num) / parseFloat(den)
            } else if (num && !den) {
                fps = parseFloat(num)
            }
        }
        if (fps !== null) fps = parseFloat(fps.toFixed(2))

        let videoBitrate = parseInt(videoStream.bit_rate)
        if (isNaN(videoBitrate)) videoBitrate = null

        const audioStream = data.streams?.find(s => s.codec_type === 'audio')
        let audioCodec = null, audioBitrate = null, sampleRate = null, channels = null
        if (audioStream) {
            audioCodec = audioStream.codec_name?.toUpperCase() || '未知'
            audioBitrate = parseInt(audioStream.bit_rate)
            if (isNaN(audioBitrate)) audioBitrate = null
            sampleRate = audioStream.sample_rate ? `${parseInt(audioStream.sample_rate) / 1000} kHz` : null
            channels = audioStream.channels ? `${audioStream.channels}` : null
        }

        let totalBitrate = parseInt(data.format?.bit_rate)
        if (isNaN(totalBitrate)) totalBitrate = null

        if (!videoBitrate && totalBitrate && audioBitrate) {
            videoBitrate = totalBitrate - audioBitrate
            if (videoBitrate < 0) videoBitrate = null
        }

        const fileSize = parseInt(data.format?.size) || (await fs.stat(filePath)).size
        return {
            container, videoCodec, width, height, durationSec, fps,
            videoBitrate, audioCodec, audioBitrate, sampleRate, channels,
            totalBitrate, size: fileSize
        }
    } catch (err) {
        throw new Error(`ffprobe 分析失败: ${err.message}`)
    }
}

// ==================== 插件主类 ====================

export class mediaInfo extends plugin {
    constructor() {
        super({
            name: '[ffmpeg-plugin]媒体信息',
            event: 'message.group',
            priority: 1000,
            rule: [
                { reg: '^#?音频信息$', fnc: 'audioInfoHandler' },
                { reg: '^#?图片信息$', fnc: 'imageInfoHandler' },
                { reg: '^#?视频信息$', fnc: 'videoInfoHandler' }
            ]
        })
    }

    async getReplyByMsgId(e) {
        if (!e.getReply) return null
        try {
            const rawMessage = await e.getReply()
            if (!rawMessage?.message) return null
            logger.info(`获取到引用消息，消息段数量: ${Array.isArray(rawMessage.message) ? rawMessage.message.length : 0}`)
            return rawMessage
        } catch (error) {
            logger.error(`通过 getReply 获取消息失败: ${error}`)
            return null
        }
    }

    async getReplyBySource(e) {
        if (!e.source) return null
        try {
            const target = e[e.isGroup ? 'group' : 'friend']
            if (!target?.getChatHistory) return null
            const seq = e.isGroup ? e.source.seq : (e.source.time ? e.source.time + 1 : undefined)
            if (seq === undefined) return null
            const messages = await target.getChatHistory(seq, 1)
            const rawMessage = messages.pop()
            if (!rawMessage?.message) return null
            logger.info(`通过 source 获取到消息，消息段数量: ${Array.isArray(rawMessage.message) ? rawMessage.message.length : 0}`)
            return rawMessage
        } catch (error) {
            logger.error(`通过 source 获取消息失败: ${error}`)
            return null
        }
    }

    async getReplyMsg(e) {
        const replyMsg = await this.getReplyByMsgId(e)
        if (replyMsg) return replyMsg
        const sourceMsg = await this.getReplyBySource(e)
        if (sourceMsg) return sourceMsg
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
            logger.error('创建合并转发消息失败:', forwardErr)
            await e.reply(message, true)
        }
    }

    // ========== icqq：获取媒体真实下载链接 ==========
    async _getMediaUrl(segment, e) {
        const data = segment.data || {}
        const candidates = [
            segment.url,
            data.url,
            segment.file,
            data.file,
            segment.src,
            data.src,
            segment.origin,
            data.origin
        ]
        for (const candidate of candidates) {
            if (isHttpUrl(candidate)) return candidate
        }

        const target = e[e.isGroup ? 'group' : 'friend']
        const segPayload = normalizeForApi(segment)

        if (target?.getVideoUrl && segment.type === 'video') {
            try {
                const url = await target.getVideoUrl(segPayload)
                if (isHttpUrl(url)) return url
            } catch (err) {
                logger.warn(`通过 getVideoUrl 获取下载链接失败: ${err.message}`)
            }
        }

        if (target?.getPicUrl && segment.type === 'image') {
            try {
                const url = await target.getPicUrl(segPayload)
                if (isHttpUrl(url)) return url
            } catch (err) {
                logger.warn(`通过 getPicUrl 获取下载链接失败: ${err.message}`)
            }
        }

        if (target?.getPttUrl && (segment.type === 'record' || segment.type === 'audio')) {
            try {
                const url = await target.getPttUrl(segPayload)
                if (isHttpUrl(url)) return url
            } catch (err) {
                logger.warn(`通过 getPttUrl 获取下载链接失败: ${err.message}`)
            }
        }

        const fid = data.fid || segment.fid
        if (fid && target?.getFileUrl) {
            try {
                const url = await target.getFileUrl(fid)
                if (isHttpUrl(url)) return url
            } catch (err) {
                logger.warn(`通过 getFileUrl 获取下载链接失败: ${err.message}`)
            }
        }

        throw new Error('无法获取可下载直链（需要 http/https url）')
    }

    _getFileExtension(segment) {
        const data = segment.data || {}
        const nameCandidates = [
            data.filename,
            data.file_name,
            data.name,
            data.title,
            data.file,
            segment.file,
            data.url,
            segment.url
        ]

        for (const candidate of nameCandidates) {
            if (typeof candidate !== 'string' || !candidate.trim()) continue
            let source = candidate
            if (/^https?:\/\//i.test(source)) {
                try {
                    source = new URL(source).pathname
                } catch (e) {
                    source = source.split('?')[0]
                }
            }
            const ext = path.extname(source).toLowerCase().slice(1)
            if (ext) return ext
        }
        return null
    }

    extractAudiosFromMsg(messageArray) {
        if (!Array.isArray(messageArray)) return []
        const audioExtensions = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'opus', 'wma', 'ape', 'amr', 'silk', 'weba', 'mpga', 'aif', 'aiff']
        return messageArray.filter(seg => {
            const data = seg?.data || {}
            if (seg.type === 'audio' || seg.type === 'record') return true
            if (seg.type === 'file') {
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
            let url = null
            let tempFilePath = null
            try {
                url = await this._getMediaUrl(seg, e)
                tempFilePath = await downloadMediaToTemp(url)
                await getAudioInfoByFfprobe(tempFilePath)
                detected.push(seg)
            } catch (err) {
                // ignore non-audio file segment
            } finally {
                if (tempFilePath) await fs.unlink(tempFilePath).catch(() => {})
            }
        }
        return detected
    }

    extractImagesFromMsg(messageArray) {
        if (!Array.isArray(messageArray)) return []
        const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'ico', 'tiff']
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
        const videoExtensions = ['mp4', 'avi', 'mkv', 'mov', 'flv', 'wmv', 'webm', 'm4v', '3gp']
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
        const data = segment.data || {}
        const nameCandidates = [data.filename, data.file_name, data.name, data.title]
        for (const name of nameCandidates) {
            if (typeof name === 'string' && name.trim()) return name.trim()
        }
        if (data.file && typeof data.file === 'string') {
            const base = path.basename(data.file)
            if (base && base !== '/' && base !== '\\') {
                return base
            }
        }
        if (data.url && typeof data.url === 'string') {
            try {
                const urlWithoutQuery = data.url.split('?')[0]
                const urlBase = path.basename(urlWithoutQuery)
                if (urlBase && urlBase.length > 0 && urlBase !== '/') {
                    return decodeURIComponent(urlBase)
                }
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
            if (audios.length === 0) {
                audios = await this.detectAudioFilesByProbe(replyMsg.message, e)
            }
        }

        if (audios.length === 0 && e.message) {
            audios = this.extractAudiosFromMsg(e.message)
            if (audios.length === 0) {
                audios = await this.detectAudioFilesByProbe(e.message, e)
            }
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
                logger.error(`处理音频失败: ${err.message}`)
                results.push(`❌ 音频 ${displayNameNoExt} 处理失败：${err.message}`)
            } finally {
                if (tempFilePath) await fs.unlink(tempFilePath).catch(() => {})
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
        if (replyMsg && replyMsg.message) {
            images = this.extractImagesFromMsg(replyMsg.message)
        }

        if (images.length === 0 && e.message) {
            images = this.extractImagesFromMsg(e.message)
        }

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
                logger.error(`处理图片失败: ${err.message}`)
                results.push(`❌ 图片 ${displayNameNoExt} 处理失败：${err.message}`)
            } finally {
                if (tempFilePath) await fs.unlink(tempFilePath).catch(() => {})
            }
        }

        await this.replyWithForward(e, results.join('\n\n----------------\n\n'), '图片信息')
    }

    // ========== 视频信息处理 ==========
    async videoInfoHandler(e) {
        let videos = []

        const replyMsg = await this.getReplyMsg(e)
        if (replyMsg && replyMsg.message) {
            videos = this.extractVideosFromMsg(replyMsg.message)
        }

        if (videos.length === 0 && e.message) {
            videos = this.extractVideosFromMsg(e.message)
        }

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
            if (video.data?.file) {
                const base = path.basename(video.data.file)
                const ext = path.extname(base)
                if (ext && ext !== '.') fallbackExt = ext
            }

            let fileSizeBytes = parseInt(video.data?.file_size)
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
                logger.error(`处理视频失败: ${err.message}`)
                if (err.message.includes('未找到视频流')) {
                    results.push(`❌ 视频 ${displayNameNoExt} 可能不是视频文件（或为 GIF 动图），请使用 #图片信息 命令。`)
                } else {
                    results.push(`❌ 视频 ${displayNameNoExt} 处理失败：${err.message}`)
                }
            } finally {
                if (tempFilePath) await fs.unlink(tempFilePath).catch(() => {})
            }
        }

        await this.replyWithForward(e, results.join('\n\n----------------\n\n'), '视频信息')
    }
}