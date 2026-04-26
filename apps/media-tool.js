import fs from 'fs'
import path from 'path'
import axios from 'axios'
import { exec } from 'child_process'
import { promisify } from 'util'
import { createWriteStream } from 'fs'
import os from 'os'
import archiver from 'archiver'

const execPromise = promisify(exec)

// ================= 公共辅助函数 =================

function ensureTempDir() {
    const tempDir = path.join(process.cwd(), 'temp', 'ffmpeg')
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true })
        logger.info(`[多媒体插件] 创建临时目录: ${tempDir}`)
    }
    return tempDir
}

function getTempFilePath(extension) {
    const tempDir = ensureTempDir()
    const randomName = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}${extension}`
    return path.join(tempDir, randomName)
}

async function downloadFile(url, destPath) {
    const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'stream',
        timeout: 60000,
        maxContentLength: 200 * 1024 * 1024
    })
    const writer = createWriteStream(destPath)
    response.data.pipe(writer)
    await new Promise((resolve, reject) => {
        writer.on('finish', resolve)
        writer.on('error', reject)
    })
    return destPath
}

async function downloadImageToTemp(url) {
    const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'stream',
        timeout: 15000
    })
    const ext = path.extname(url).split('?')[0] || '.tmp'
    const tempFile = getTempFilePath(ext)
    const writer = createWriteStream(tempFile)
    response.data.pipe(writer)
    await new Promise((resolve, reject) => {
        writer.on('finish', resolve)
        writer.on('error', reject)
    })
    return tempFile
}

function formatSizeMB(bytes) {
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
}

function isHttpUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url.trim())
}

function normalizeForApi(input) {
    return JSON.parse(JSON.stringify(input, (_, value) =>
        typeof value === 'bigint' ? value.toString() : value
    ))
}

function isLikelyImageUrl(url) {
    if (!isHttpUrl(url)) return false
    const clean = url.split('?')[0].toLowerCase()
    if (/\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(clean)) return true
    if (/\/0(?:$|\/)/.test(clean) && /qpic\.cn/i.test(clean)) return true
    return false
}

function getSegField(seg, key) {
    const data = seg?.data || {}
    const fromData = data[key]
    if (fromData !== undefined && fromData !== null && fromData !== '') return fromData
    const fromSeg = seg?.[key]
    if (fromSeg !== undefined && fromSeg !== null && fromSeg !== '') return fromSeg
    return undefined
}

function getSegmentFileName(seg, defaultName = '') {
    const fileName = getSegField(seg, 'filename') || getSegField(seg, 'name') || getSegField(seg, 'file') || ''
    if (typeof fileName === 'string' && !fileName.startsWith('fid:')) return fileName
    const url = getSegField(seg, 'url')
    if (typeof url === 'string' && url.trim() !== '') {
        const urlPath = url.split('?')[0]
        const base = path.basename(urlPath)
        if (base) return base
    }
    return defaultName
}

function getSegmentExt(seg) {
    const fileName = getSegmentFileName(seg)
    return path.extname(fileName).toLowerCase()
}

async function cleanupTempFile(filePath) {
    if (filePath && fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath).catch(err => logger.warn(`清理失败: ${filePath} - ${err.message}`))
    }
}

async function removePath(targetPath) {
    try {
        await fs.promises.rm(targetPath, { recursive: true, force: true })
    } catch (e) {}
}

async function getImageFormatByFfprobe(filePath) {
    try {
        const { stdout } = await execPromise(`ffprobe -v quiet -print_format json -show_streams "${filePath}"`)
        const data = JSON.parse(stdout)
        const videoStream = data.streams?.find(s => s.codec_type === 'video')
        if (!videoStream) return '未知'
        let format = videoStream.codec_name?.toUpperCase() || '未知'
        if (format === 'JPEG') format = 'JPG'
        else if (format === 'PNG') format = 'PNG'
        else if (format === 'GIF') format = 'GIF'
        else if (format === 'WEBP') format = 'WEBP'
        return format
    } catch (err) {
        return '未知'
    }
}

async function decomposeGifToPngs(inputGifPath, outputDir, maxFrames = 100) {
    await fs.promises.mkdir(outputDir, { recursive: true })
    const outputPattern = path.join(outputDir, '%d.png')
    const cmd = `ffmpeg -i "${inputGifPath}" -frames:v ${maxFrames} -f image2 "${outputPattern}"`
    try {
        await execPromise(cmd, { timeout: 60000 })
    } catch (err) {
        throw new Error(`ffmpeg 分解失败: ${err.message}`)
    }
    const files = await fs.promises.readdir(outputDir)
    const pngFiles = files.filter(f => f.endsWith('.png')).map(f => ({
        name: f,
        num: parseInt(path.basename(f, '.png'), 10)
    })).sort((a, b) => a.num - b.num).map(item => path.join(outputDir, item.name))
    if (pngFiles.length === 0) throw new Error('未生成任何 PNG 帧')
    return pngFiles
}

async function packPngsToZip(pngFiles, zipOutputPath) {
    return new Promise((resolve, reject) => {
        const output = createWriteStream(zipOutputPath)
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
            event: 'message.group',
            priority: 310,
            rule: [
                { reg: /^#(转动图|转gif)$/i, fnc: 'convertToGif' },
                { reg: /^#?动图分解$/, fnc: 'decomposeGif' },
                { reg: /^#?gif分解$/i, fnc: 'decomposeGif' },
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
        logger.info(`[DEBUG] extractVideoFromMsg 输入数组长度: ${messageArray.length}`)
        const videos = messageArray.filter(seg => seg.type === 'video')
        const files = messageArray.filter(seg => seg.type === 'file')
        logger.info(`[DEBUG] 找到 video 段: ${videos.length}, file 段: ${files.length}`)

        const videoExts = ['.mp4', '.mkv', '.avi', '.mov', '.flv', '.webm', '.wmv', '.m4v', '.3gp', '.ts']
        for (const file of files) {
            const fileName = getSegmentFileName(file)
            const ext = getSegmentExt(file)
            logger.info(`[DEBUG] file 段提取文件名: ${fileName}`)
            logger.info(`[DEBUG] 扩展名: ${ext}, 是否为视频: ${videoExts.includes(ext)}`)
            if (videoExts.includes(ext)) {
                videos.push(file)
                logger.info('[DEBUG] 已将该 file 段加入视频列表')
            }
        }
        logger.info(`[DEBUG] 最终视频段数量: ${videos.length}`)
        return videos
    }

    extractAudioFromMsg(messageArray) {
        if (!Array.isArray(messageArray)) return []
        const audioSegments = []
        const directAudios = messageArray.filter(seg => seg.type === 'audio' || seg.type === 'record')
        audioSegments.push(...directAudios)
        const files = messageArray.filter(seg => seg.type === 'file')
        const audioExts = ['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.wma', '.ape', '.aiff']
        for (const file of files) {
            const fileName = getSegmentFileName(file)
            const ext = path.extname(fileName).toLowerCase()
            if (audioExts.includes(ext)) {
                audioSegments.push(file)
            }
        }
        return audioSegments
    }

    extractImagesFromMsg(messageArray) {
        if (!Array.isArray(messageArray)) return []
        return messageArray.filter(seg => seg.type === 'image')
    }

    async getReplyByMsgId(e) {
        if (!e.getReply) return null
        try {
            const rawMessage = await e.getReply()
            if (!rawMessage?.message) return null
            return rawMessage
        } catch (error) {
            logger.error(`[多媒体插件] 获取引用消息失败: ${error}`)
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
            return rawMessage
        } catch (error) {
            logger.error(`[多媒体插件] 通过source获取消息失败: ${error}`)
            return null
        }
    }

    async getQuotedMessageRaw(e) {
        const replyMsg = await this.getReplyByMsgId(e)
        if (replyMsg) return replyMsg
        return await this.getReplyBySource(e)
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

        // 视频链路
        if (segment.type === 'video') {
            // 私聊：仅使用 getVideoUrl()
            if (!e.isGroup) {
                if (!target?.getVideoUrl) {
                    throw new Error('私聊不支持 getVideoUrl 获取视频直链')
                }
                try {
                    const url = await target.getVideoUrl(segPayload)
                    if (isHttpUrl(url) && !isLikelyImageUrl(url)) {
                        logger.info('[多媒体插件] 私聊通过 getVideoUrl 获取视频直链成功')
                        return url
                    }
                    if (isHttpUrl(url)) {
                        logger.warn(`[多媒体插件] 私聊 getVideoUrl 返回疑似图片链接: ${url}`)
                    }
                } catch (err) {
                    logger.warn(`[多媒体插件] 私聊 getVideoUrl 失败: ${err.message}`)
                }
                throw new Error('私聊仅使用 getVideoUrl 获取视频直链失败')
            }

            // 群聊：保留多策略
            for (const candidate of candidates) {
                if (isHttpUrl(candidate)) {
                    if (isLikelyImageUrl(candidate)) {
                        logger.warn(`[多媒体插件] 视频消息直链疑似图片缩略图，已忽略: ${candidate}`)
                        continue
                    }
                    logger.debug(`[多媒体插件] 使用视频消息中的直链: ${candidate}`)
                    return candidate
                }
            }

            if (fid && e.group_id && typeof Bot?.sendOidbSvcTrpcTcp === 'function') {
                try {
                    const body = {
                        1: { 1: { 1: 1, 2: 200 }, 2: { 101: 2, 102: 2, 200: 2, 202: { 1: e.group_id } }, 3: { 1: 2 } },
                        3: { 1: { 2: fid, 3: 1 }, 2: { 2: {} } }
                    }
                    const rsp = await Bot.sendOidbSvcTrpcTcp('OidbSvcTrpcTcp.0x11EA_200', body)
                    const host = rsp?.[3]?.[3]?.[1]
                    const uri = rsp?.[3]?.[3]?.[2]
                    const token = rsp?.[3]?.[1]
                    if (host && uri && token) {
                        const url = `https://${host}${uri}${token}`
                        if (isHttpUrl(url)) {
                            logger.info('[多媒体插件] 通过 ICQQ 发包获取视频直链成功')
                            return url
                        }
                    }
                } catch (err) {
                    logger.warn(`[多媒体插件] ICQQ 发包获取视频直链失败: ${err.message}`)
                }
            }

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

            if (target?.getVideoUrl) {
                try {
                    const url = await target.getVideoUrl(segPayload)
                    if (isHttpUrl(url) && !isLikelyImageUrl(url)) {
                        logger.info('[多媒体插件] 通过 getVideoUrl 获取视频直链成功')
                        return url
                    }
                    if (isHttpUrl(url)) {
                        logger.warn(`[多媒体插件] getVideoUrl 返回疑似图片链接，已忽略: ${url}`)
                    }
                } catch (err) {
                    logger.warn(`[多媒体插件] getVideoUrl 失败: ${err.message}`)
                }
            }

            throw new Error('无法获取可下载视频直链（需要原视频 URL）')
        }

        for (const candidate of candidates) {
            if (isHttpUrl(candidate)) {
                logger.debug(`[多媒体插件] 使用消息段中的直链: ${candidate}`)
                return candidate
            }
        }

        if (target?.getPicUrl && segment.type === 'image') {
            try {
                const url = await target.getPicUrl(segPayload)
                if (isHttpUrl(url)) {
                    logger.info('[多媒体插件] 通过 getPicUrl 获取图片直链成功')
                    return url
                }
            } catch (err) {
                logger.warn(`[多媒体插件] getPicUrl 失败: ${err.message}`)
            }
        }

        if (fid) {
            logger.info(`[多媒体插件] 通过 icqq getFileUrl 获取文件链接，fid: ${fid}`)
            try {
                if (target?.getFileUrl) {
                    const url = await target.getFileUrl(fid)
                    if (isHttpUrl(url)) return url
                }
            } catch (err) {
                logger.error(`[多媒体插件] getFileUrl 失败: ${err.message}`)
            }
        }

        if (target?.getPttUrl && (segment.type === 'record' || segment.type === 'audio')) {
            try {
                const url = await target.getPttUrl(segPayload)
                if (isHttpUrl(url)) {
                    logger.info('[多媒体插件] 通过 getPttUrl 获取语音直链成功')
                    return url
                }
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
            logger.info(`[DEBUG] 引用消息原始内容: ${JSON.stringify(quoted.message)}`)
            videoSegments = this.extractVideoFromMsg(quoted.message)
            logger.info(`[DEBUG] 从引用消息提取到 ${videoSegments.length} 个视频段`)
        }
        if (videoSegments.length === 0) {
            videoSegments = this.extractVideoFromMsg(e.message)
            logger.info(`[DEBUG] 从当前消息提取到 ${videoSegments.length} 个视频段`)
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
            const urlPath = fileUrl.split('?')[0]
            fileName = path.basename(urlPath)
        }
        if (!fileName || fileName.startsWith('fid:')) fileName = 'video.mp4'

        const sizeRaw = getSegField(seg, 'file_size') || getSegField(seg, 'size')
        const fileSize = sizeRaw ? parseInt(sizeRaw) : null

        return {
            segment: seg,
            fileUrl,
            fileName,
            fileSize,
        }
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
            const urlPath = fileUrl.split('?')[0]
            fileName = path.basename(urlPath)
        }
        if (!fileName || fileName.startsWith('fid:')) fileName = 'audio.bin'

        const sizeRaw = getSegField(seg, 'file_size') || getSegField(seg, 'size')
        const fileSize = sizeRaw ? parseInt(sizeRaw) : null

        return {
            segment: seg,
            fileUrl,
            fileName,
            fileSize,
        }
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

    async runFFmpeg(cmd, timeoutMs = 120000) {
        logger.info(`[多媒体插件] 执行命令: ${cmd}`)
        try {
            const { stdout, stderr } = await execPromise(cmd, { timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024 })
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
        const probeCmd = `ffprobe -v quiet -print_format json -show_streams -show_format "${inputPath}"`
        const { stdout: probeStdout } = await execPromise(probeCmd)
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
        const cmd = `ffmpeg -i "${inputPath}" -vf "${filter}" -loop 0 "${outputPath}" -y`
        await this.runFFmpeg(cmd, 180000)
        return outputPath
    }

    async convertToMp3File(inputPath, outputPath) {
        const cmd = `ffmpeg -i "${inputPath}" -c:a libmp3lame -q:a 2 "${outputPath}" -y`
        await this.runFFmpeg(cmd, 120000)
        return outputPath
    }

    async convertToFlacFile(inputPath, outputPath) {
        const cmd = `ffmpeg -i "${inputPath}" -c:a flac "${outputPath}" -y`
        await this.runFFmpeg(cmd, 120000)
        return outputPath
    }

    async sendFileAsMessage(e, filePath, displayName) {
        let stat
        try {
            stat = await fs.promises.stat(filePath)
        } catch (err) {
            throw new Error(`待发送文件不存在: ${filePath}`)
        }
        if (!stat.isFile()) {
            throw new Error(`待发送目标不是文件: ${filePath}`)
        }
        if (stat.size <= 0) {
            throw new Error(`待发送文件为空: ${filePath}`)
        }

        const fileSizeMB = (stat.size / (1024 * 1024)).toFixed(2)
        logger.info(`[多媒体插件] 准备发送文件: ${displayName}, 大小 ${fileSizeMB} MB, 路径: ${filePath}`)

        let res
        if (e.isGroup) {
            if (e.group?.sendFile) {
                try {
                    // 尽量使用原始显示名（与来源文件名保持一致）
                    res = await e.group.sendFile(filePath, '/', displayName)
                } catch (err) {
                    logger.warn(`[多媒体插件] 群聊 sendFile(带文件名) 失败，回退默认参数: ${err.message}`)
                    res = await e.group.sendFile(filePath)
                }
                logger.info('[多媒体插件] 群聊文件发送成功 (e.group.sendFile)')
            } else if (e.group?.fs?.upload) {
                res = await e.group.fs.upload(filePath, '/', displayName)
                logger.info('[多媒体插件] 群聊文件上传成功 (e.group.fs.upload)')
            } else {
                throw new Error('当前群聊环境不支持文件发送/上传')
            }
        } else {
            if (!e.friend?.sendFile) {
                throw new Error('当前私聊环境不支持文件发送')
            }
            try {
                res = await e.friend.sendFile(filePath, displayName)
            } catch (err) {
                logger.warn(`[多媒体插件] 私聊 sendFile(带文件名) 失败，回退默认参数: ${err.message}`)
                res = await e.friend.sendFile(filePath)
            }
            logger.info('[多媒体插件] 私聊文件发送成功 (e.friend.sendFile)')
        }

        if (!res) {
            throw new Error('文件发送结果为空')
        }
        return true
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
                await this.sendErrorAsForward(e, '请回复或发送一个视频文件（支持 mp4, mkv, avi, mov 等），例如：回复一条视频消息并发送 #转动图')
                return true
            }
            logger.info(`[GIF转换] 开始处理: ${video.fileName}`)

            const fileField = getSegField(video.segment, 'file')
            const canUseProtoDirect = !e.isGroup && typeof fileField === 'string' && fileField.startsWith('protobuf://')
            if (canUseProtoDirect) {
                logger.info('[GIF转换] 私聊检测到 protobuf 视频段，直接交给 ffmpeg 解码')
                inputTempPath = fileField
            } else {
                inputTempPath = getTempFilePath(path.extname(video.fileName) || '.mp4')
                await downloadFile(video.fileUrl, inputTempPath)
                const stat = await fs.promises.stat(inputTempPath)
                logger.info(`[GIF转换] 下载完成，大小: ${formatSizeMB(stat.size)}`)
            }

            outputTempPath = getTempFilePath('.gif')
            await this.convertToGifFile(inputTempPath, outputTempPath)
            const outStat = await fs.promises.stat(outputTempPath)
            logger.info(`[GIF转换] GIF生成完成，大小: ${formatSizeMB(outStat.size)}`)
            await e.reply(segment.image(outputTempPath))
            logger.info(`[GIF转换] GIF发送成功`)
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
            tempGifPath = await downloadImageToTemp(targetImage.url)
            const format = await getImageFormatByFfprobe(tempGifPath)
            if (format !== 'GIF') {
                await this.sendErrorAsForward(e, `该图片格式为 ${format}，仅支持 GIF 动图分解。`)
                return true
            }
            const uniqueId = `${Date.now()}_${Math.random().toString(36).slice(2)}`
            outputDir = path.join(ensureTempDir(), 'decompose', uniqueId)
            const maxFrames = 100
            const pngFiles = await decomposeGifToPngs(tempGifPath, outputDir, maxFrames)
            const totalFrames = pngFiles.length
            if (totalFrames === 0) {
                await this.sendErrorAsForward(e, '分解后未生成任何图片帧。')
                return true
            }

            // 构建 icqq 合并转发消息
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
                logger.error('合并转发失败，降级为逐张发送:', forwardErr)
                await e.reply('⏳ 正在下载图片并检测格式...\n⏳ 正在分解 GIF...\n温馨提醒（最多 100 帧）', true)
                for (let i = 0; i < totalFrames; i++) {
                    const base64Data = await fs.promises.readFile(pngFiles[i], 'base64')
                    await e.reply([`第 ${i + 1} 帧`, segment.image(`base64://${base64Data}`)])
                    await new Promise(r => setTimeout(r, 500))
                }
                await e.reply(`✅ 分解完成，共 ${totalFrames} 帧。`, true)
            }
        } catch (err) {
            logger.error(`动图分解失败: ${err.message}`)
            await this.sendErrorAsForward(e, `处理失败：${err.message}`)
        } finally {
            if (tempGifPath) await cleanupTempFile(tempGifPath).catch(() => {})
            if (outputDir) await removePath(outputDir).catch(() => {})
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
            tempGifPath = await downloadImageToTemp(targetImage.url)
            const format = await getImageFormatByFfprobe(tempGifPath)
            if (format !== 'GIF') {
                await this.sendErrorAsForward(e, `该图片格式为 ${format}，仅支持 GIF 动图打包。`)
                return true
            }
            const uniqueId = `${Date.now()}_${Math.random().toString(36).slice(2)}`
            outputDir = path.join(ensureTempDir(), 'decompose', uniqueId)
            const maxFrames = 300
            const pngFiles = await decomposeGifToPngs(tempGifPath, outputDir, maxFrames)
            const totalFrames = pngFiles.length
            zipFilePath = path.join(ensureTempDir(), `gif_frames_${uniqueId}.zip`)
            await packPngsToZip(pngFiles, zipFilePath)
            const displayName = `gif_frames_${uniqueId}.zip`
            await this.sendFileAsMessage(e, zipFilePath, displayName)
            sendSuccess = true
            // 不发送任何文本提示
        } catch (err) {
            logger.error(`动图打包失败: ${err.message}`)
            await this.sendErrorAsForward(e, `处理失败：${err.message}`)
        } finally {
            if (tempGifPath) await cleanupTempFile(tempGifPath).catch(() => {})
            if (outputDir) await removePath(outputDir).catch(() => {})
            if (zipFilePath && sendSuccess) {
                await cleanupTempFile(zipFilePath).catch(() => {})
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
                await this.sendErrorAsForward(e, '请回复或发送一个视频文件（mp4, mkv, avi, mov等），然后发送 #转语音')
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
            await e.reply(segment.image(outputTempPath))
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
                await this.sendErrorAsForward(e, '请回复或发送一个视频/音频文件（支持 mp4, mkv, avi, mov, mp3, flac, wav, m4a 等），然后发送 #转mp3')
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
            logger.info(`[转MP3] 文件发送成功`)
            // 不发送完成提示消息
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
                await this.sendErrorAsForward(e, '请回复或发送一个视频/音频文件（支持 mp4, mkv, avi, mov, mp3, flac, wav, m4a 等），然后发送 #转flac')
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
            logger.info(`[转FLAC] 文件发送成功`)
            // 不发送完成提示消息
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