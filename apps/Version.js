import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import path from 'path'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { ensureTempDir } from './utils.js'

const execFileAsync = promisify(execFile)

async function getFfmpegVersionInfo() {
  try {
    const { stdout } = await execFileAsync('ffmpeg', ['-version'])
    return stdout
  } catch (err) {
    throw new Error(`执行 ffmpeg -version 失败: ${err.message}`)
  }
}

function extractVersionNumber(versionOutput) {
  const match = versionOutput.match(/ffmpeg version\s+(\S+)/i)
  return match ? match[1] : '未知'
}

function getBaseVersionDescription(versionOutput, versionNumber) {
  const stableMatch = versionOutput.match(/ffmpeg version\s+(\d+\.\d+)/i)
  if (stableMatch) return `基于 FFmpeg ${stableMatch[1]} 构建`
  if (versionNumber.startsWith('N-') || versionNumber.includes('g') || versionNumber.includes('-')) {
    return `基于 FFmpeg git 开发版 (BtbN 自动构建)`
  }
  return `基于 FFmpeg 自定义构建`
}

function getEnabledFeatures(versionOutput) {
  const match = versionOutput.match(/configuration:\s+(.+)/)
  if (!match) return []
  const parts = match[1].trim().split(/\s+/)
  const enableFeatures = parts
    .filter(part => part.startsWith('--enable-'))
    .map(part => part.slice(9))
  return [...new Set(enableFeatures)]
}

async function getGitLogDetailed(pluginDir) {
  try {
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: pluginDir })
    const { stdout } = await execFileAsync('git', [
      'log', '-n', '5', '--pretty=format:%h|%s|%an|%ad', '--date=format-local:%Y-%m-%d %H:%M:%S'
    ], { cwd: pluginDir })
    if (!stdout.trim()) return []
    return stdout.split('\n').map(line => {
      const [hash, title, author, date] = line.split('|')
      return { hash: hash || '未知', title: title || '无标题', author: author || '未知', date: date || '未知' }
    })
  } catch (err) {
    logger.error('[ffmpeg-plugin] 获取 Git 日志失败:', err.message)
    return []
  }
}

function escapeHtml(str) {
  if (!str) return ''
  return str.replace(/[&<>]/g, (m) => {
    if (m === '&') return '&amp;'
    if (m === '<') return '&lt;'
    if (m === '>') return '&gt;'
    return m
  })
}

function buildHtml(versionRaw, versionNumber, commits) {
  const baseVersionDesc = getBaseVersionDescription(versionRaw, versionNumber)
  const enabledFeatures = getEnabledFeatures(versionRaw)
  const featuresHtml = enabledFeatures.map(f => `<span class="config-chip">${escapeHtml(f)}</span>`).join('')

  const commitsHtml = commits.map(commit => `
    <li class="commit-item">
      <div class="commit-hash">${escapeHtml(commit.hash)}</div>
      <div class="commit-body">
        <div class="commit-title">${escapeHtml(commit.title)}</div>
        <div class="commit-meta">
          <span>👤 ${escapeHtml(commit.author)}</span>
          <span>📅 ${escapeHtml(commit.date)}</span>
          <span>🌿 main</span>
        </div>
      </div>
    </li>
  `).join('')

  const now = new Date()
  const formattedTime = `${now.getFullYear()}/${now.getMonth()+1}/${now.getDate()} ${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')}`

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ffmpeg-plugin 信息看板</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f4f7fc; color: #0f172a; line-height: 1.5; padding: 2rem 1.5rem; font-size: 16px; }
        .container { max-width: 1280px; margin: 0 auto; }
        .page-header { margin-bottom: 2.5rem; text-align: center; border-bottom: 2px solid #e2edf7; padding-bottom: 1.2rem; }
        .page-header h1 { font-size: 2.6rem; font-weight: 600; background: linear-gradient(135deg, #1e4a76, #2c6288); background-clip: text; -webkit-background-clip: text; color: transparent; display: inline-flex; align-items: center; gap: 0.6rem; }
        .page-header h1 span { font-size: 2.2rem; }
        .sub { color: #2c5a74; margin-top: 0.6rem; font-size: 1rem; font-weight: 500; }
        .card { background: #ffffff; border-radius: 1.5rem; box-shadow: 0 12px 30px -12px rgba(0, 0, 0, 0.08); padding: 1.6rem 2rem; margin-bottom: 2rem; border: 1px solid #e6edf4; }
        .card-header { display: flex; align-items: center; gap: 0.75rem; border-bottom: 2px solid #eef3fa; padding-bottom: 0.85rem; margin-bottom: 1.5rem; }
        .card-header .icon { font-size: 2rem; }
        .card-header h2 { font-size: 1.8rem; font-weight: 600; color: #0f4c5f; }
        .version-info { display: flex; flex-wrap: wrap; gap: 1rem; align-items: baseline; }
        .version-tag { background: #eef2fa; padding: 0.5rem 1.4rem; border-radius: 2rem; font-family: monospace; font-weight: 700; font-size: 1.2rem; color: #1b6b87; word-break: break-all; }
        .version-detail { color: #2c627a; font-size: 0.95rem; background: #f0f6fe; padding: 0.5rem 1.2rem; border-radius: 2rem; }
        .config-list { margin-top: 0; display: flex; flex-wrap: wrap; gap: 0.8rem; }
        .config-chip { background: #f8fafc; border: 1px solid #dfe8f0; border-radius: 2rem; padding: 0.5rem 1.2rem; font-size: 1rem; font-family: monospace; color: #1f5e7e; }
        .commit-list { list-style: none; }
        .commit-item { display: flex; align-items: flex-start; gap: 1rem; padding: 1rem 0; border-bottom: 1px solid #eef2f7; }
        .commit-item:last-child { border-bottom: none; }
        .commit-hash { font-family: monospace; background: #ecf3f9; padding: 0.3rem 0.8rem; border-radius: 0.6rem; font-size: 0.9rem; font-weight: 600; color: #1a6885; }
        .commit-body { flex: 1; }
        .commit-title { font-weight: 650; font-size: 1rem; color: #115e7c; margin-bottom: 0.3rem; }
        .commit-meta { font-size: 0.8rem; color: #5f7f9a; display: flex; gap: 1rem; flex-wrap: wrap; }
        .codec-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 1.2rem; }
        .codec-category { background: #fbfdff; border-radius: 1.2rem; padding: 1rem 1.2rem; border: 1px solid #e4edf6; }
        .codec-category h3 { font-size: 1.2rem; font-weight: 700; margin-bottom: 0.8rem; color: #1c5a78; }
        .codec-list { display: flex; flex-wrap: wrap; gap: 0.8rem; }
        .codec-badge { background: #e7f0f9; padding: 0.5rem 1.2rem; border-radius: 1.5rem; font-size: 1rem; font-weight: 500; font-family: monospace; color: #146b8a; }
        .footer { margin-top: 2rem; text-align: center; padding: 1.2rem 1rem; font-size: 0.9rem; color: #54708f; border-top: 1px solid #dfeaf3; background: #ffffffdd; border-radius: 1rem; }
        .footer .powered { font-weight: 600; color: #1d6f93; margin-top: 0.3rem; font-size: 0.9rem; }
        @media (max-width: 640px) { body { padding: 1rem; font-size: 14px; } .card { padding: 1.2rem; } .card-header h2 { font-size: 1.5rem; } .commit-item { flex-direction: column; gap: 0.4rem; } .version-tag { font-size: 1rem; } }
    </style>
</head>
<body>
<div class="container">
    <div class="page-header">
        <h1><span>🎬</span> ffmpeg-plugin</h1>
        <div class="sub">基于 FFmpeg 的 Yunzai-Bot 插件，提供图像、音视频处理及信息查询功能</div>
    </div>

    <div class="card">
        <div class="card-header">
            <div class="icon">📦</div>
            <h2>FFmpeg 版本</h2>
        </div>
        <div class="version-info">
            <div class="version-tag">ffmpeg version ${escapeHtml(versionNumber)}</div>
            <div class="version-detail">${escapeHtml(baseVersionDesc)}</div>
        </div>
    </div>

    <div class="card">
        <div class="card-header">
            <div class="icon">📝</div>
            <h2>ffmpeg-plugin 插件更新记录</h2>
        </div>
        <ul class="commit-list">
            ${commitsHtml || '<li style="padding:1rem;">暂无提交记录</li>'}
        </ul>
    </div>

    <div class="card">
        <div class="card-header">
            <div class="icon">⚙️</div>
            <h2>ffmpeg 编解码库</h2>
        </div>
        <div class="codec-grid">
            <div class="codec-category">
                <h3>🎞️ 视频编码器</h3>
                <div class="codec-list">
                    <span class="codec-badge">H.264 / AVC</span>
                    <span class="codec-badge">H.265 / HEVC</span>
                    <span class="codec-badge">VP9</span>
                    <span class="codec-badge">AV1 (libaom)</span>
                    <span class="codec-badge">MPEG-4</span>
                </div>
            </div>
            <div class="codec-category">
                <h3>🎵 音频编码器</h3>
                <div class="codec-list">
                    <span class="codec-badge">AAC</span>
                    <span class="codec-badge">MP3 (LAME)</span>
                    <span class="codec-badge">Opus</span>
                    <span class="codec-badge">FLAC</span>
                    <span class="codec-badge">Vorbis</span>
                </div>
            </div>
            <div class="codec-category">
                <h3>🔓 硬件加速</h3>
                <div class="codec-list">
                    <span class="codec-badge">VAAPI</span>
                    <span class="codec-badge">NVENC</span>
                    <span class="codec-badge">QSV</span>
                    <span class="codec-badge">AMF</span>
                </div>
            </div>
            <div class="codec-category">
                <h3>📦 封装格式</h3>
                <div class="codec-list">
                    <span class="codec-badge">MP4 / MOV</span>
                    <span class="codec-badge">MKV</span>
                    <span class="codec-badge">WebM</span>
                    <span class="codec-badge">HLS (M3U8)</span>
                </div>
            </div>
        </div>
    </div>

    <div class="card">
        <div class="card-header">
            <div class="icon">🔧</div>
            <h2>详细编译配置</h2>
        </div>
        <div class="config-list">
            ${featuresHtml || '<span class="config-chip">无 --enable- 项</span>'}
        </div>
    </div>

    <div class="footer">
        <div>生成时间: ${formattedTime}</div>
        <div class="powered">Created By Yunzai-Bot & ffmpeg-plugin</div>
    </div>
</div>
</body>
</html>`
}

async function htmlToImageFile(html) {
  const tempDir = await ensureTempDir()
  const uniq = `${Date.now()}_${Math.random().toString(36).slice(2)}`
  const tplFile = path.join(tempDir, `ffmpeg_version_${uniq}.html`)
  const tempFilePath = path.join(tempDir, `ffmpeg_info_${uniq}.png`)

  try {
    await fs.writeFile(tplFile, html, 'utf8')
    const img = await puppeteer.screenshot('ffmpeg-version', {
      tplFile,
      saveId: `version_${uniq}`,
      viewport: { width: 1000, height: 1200 },
      quality: 100
    })
    return img
  } finally {
    await fs.unlink(tplFile).catch(() => {})
  }
}

export class ffmpegVersion extends plugin {
  constructor() {
    super({
      name: '[ffmpeg-plugin]FFmpeg版本查询',
      event: 'message',
      priority: 1000,
      rule: [
        {
          reg: /^#(ffmpeg版本|ff版本)$/i,
          fnc: 'getFfmpegInfo'
        }
      ]
    })
  }

  async getFfmpegInfo(e) {
    try {
      const versionRaw = await getFfmpegVersionInfo()
      const versionNumber = extractVersionNumber(versionRaw)

      const rootDir = process.cwd()
      const pluginDir = path.join(rootDir, 'plugins', 'ffmpeg-plugin')
      let commits = []
      try {
        await fs.access(pluginDir)
        commits = await getGitLogDetailed(pluginDir)
      } catch (err) {
        logger.error('[ffmpeg-plugin] 插件目录访问失败:', err.message)
        commits = []
      }

      const html = buildHtml(versionRaw, versionNumber, commits)
      const result = await htmlToImageFile(html)

      if (result) {
        await e.reply(result)
      } else {
        await e.reply('❌ 版本信息图片生成失败，请稍后再试。', true)
      }
    } catch (err) {
      logger.error('[ffmpeg-plugin] 查询 FFmpeg 信息失败:', err)
      await e.reply(`❌ 查询失败: ${err.message}`, true)
    }
  }
}
