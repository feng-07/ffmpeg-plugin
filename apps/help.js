import fs from 'fs/promises'
import path from 'path'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'

// 模板目录路径
const TEMPLATE_DIR = path.join(process.cwd(), 'temp', 'ffmpeg', 'tpl')

/**
 * 确保模板临时目录存在
 */
async function ensureTemplateDir() {
  await fs.mkdir(TEMPLATE_DIR, { recursive: true })
  return TEMPLATE_DIR
}

/**
 * 生成帮助菜单的 HTML 内容
 */
async function buildHelpHtml() {
  const now = new Date()
  const formattedTime = `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`

  // 功能菜单数据
  const modules = [
    {
      name: '📦 更新管理',
      icon: '🔄',
      desc: '插件自更新功能（仅BOT主人可用）',
      commands: [
        { cmd: '#ff更新 / #ffmpeg-plugin更新', desc: '检查并更新插件（保留本地修改）' },
        { cmd: '#ff强制更新', desc: '强制覆盖本地修改，重置到远程最新版本' }
      ]
    },
    {
      name: 'ℹ️ 版本信息',
      icon: '📊',
      desc: '查看 FFmpeg 及插件详细信息',
      commands: [
        { cmd: '#ff版本 / #ffmpeg版本', desc: '生成 FFmpeg 版本信息卡片（包含编译配置、编解码库等）' }
      ]
    },
    {
      name: '🎵 媒体信息',
      icon: '📋',
      desc: '获取音视频/图片的详细元数据',
      commands: [
        { cmd: '#音频信息', desc: '查看音频文件详情（格式、时长、比特率、采样率等）' },
        { cmd: '#图片信息', desc: '查看图片详情（分辨率、格式、GIF 帧数等）' },
        { cmd: '#视频信息', desc: '查看视频详情（编码、分辨率、码率、音频流等）' }
      ],
      note: '💡 使用方法：回复/引用包含媒体的消息，或直接发送带有媒体的命令'
    },
    {
      name: '✂️ 去黑边 / 去白边',
      icon: '🎬',
      desc: '自动裁剪图片/视频的四周黑边或白边区域',
      commands: [
        { cmd: '#去黑边', desc: '自动检测并裁剪媒体文件四周的黑边' },
        { cmd: '#去白边', desc: '自动检测并裁剪媒体文件四周的白边' }
      ],
      note: '💡 支持图片和视频，可批量处理（最多10个）'
    },
    {
      name: '🛠️ 多媒体工具箱',
      icon: '🔧',
      desc: '视频转GIF、GIF分解打包、音频/视频格式转换',
      commands: [
        { cmd: '#转动图 / #转gif', desc: '将视频转换为 GIF 动图（自动压缩至合适尺寸）' },
        { cmd: '#动图分解 / #gif分解', desc: '将 GIF 动图分解为 PNG 帧序列（合并转发）' },
        { cmd: '#动图打包 / #gif打包', desc: '将 GIF 动图的所有帧打包为 ZIP 压缩包' },
        { cmd: '#转语音', desc: '提取视频中的音频并转换为 MP3 语音消息' },
        { cmd: '#转mp3', desc: '将音/视频文件转换为 MP3 音频文件' },
        { cmd: '#转flac', desc: '将音/视频文件转换为 FLAC 无损音频文件' }
      ]
    },
    {
      name: '❓ 帮助菜单',
      icon: '📖',
      desc: '显示本帮助信息',
      commands: [
        { cmd: '#ff帮助 / #ffmpeg-plugin帮助', desc: '生成此帮助菜单图片' }
      ]
    }
  ]

  // 生成命令列表 HTML
  const modulesHtml = modules.map(mod => `
    <div class="module-card">
      <div class="module-header">
        <div class="module-icon">${mod.icon}</div>
        <div class="module-title">
          <h3>${escapeHtml(mod.name)}</h3>
          <p>${escapeHtml(mod.desc)}</p>
        </div>
      </div>
      <div class="command-list">
        ${mod.commands.map(cmd => `
          <div class="command-item">
            <div class="command-cmd"><code>${escapeHtml(cmd.cmd)}</code></div>
            <div class="command-desc">${escapeHtml(cmd.desc)}</div>
          </div>
        `).join('')}
      </div>
      ${mod.note ? `<div class="module-note">${escapeHtml(mod.note)}</div>` : ''}
    </div>
  `).join('')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>FFmpeg Plugin 帮助菜单</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            background: #ffffff;
            padding: 0;
            line-height: 1.4;
            font-size: 20px;
            -webkit-font-smoothing: antialiased;
            text-rendering: optimizeLegibility;
        }

        .container {
            max-width: 100%;
            margin: 0;
        }

        .main-card {
            background: #ffffff;
            border-radius: 0;
            box-shadow: none;
            overflow: hidden;
        }

        .header {
            background: #3b82f6;
            padding: 1rem 1.5rem;
            text-align: center;
            color: white;
        }

        .header h1 {
            font-size: 2.2rem;
            font-weight: 600;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.6rem;
        }

        .header h1 span {
            font-size: 2rem;
        }

        .header .sub {
            margin-top: 0.6rem;
            font-size: 1.5rem;
            font-weight: 500;
            opacity: 0.92;
        }

        .content {
            padding: 1.5rem 3rem 1rem;
        }

        .module-card {
            background: transparent;
            border-radius: 0;
            margin-bottom: 1.5rem;
            padding: 0;
            border: none;
        }

        .module-card:last-child {
            margin-bottom: 0;
        }

        .module-header {
            display: flex;
            align-items: center;
            gap: 0.8rem;
            margin-bottom: 0.8rem;
            padding-bottom: 0.4rem;
            border-bottom: 2px solid #eef2f5;
        }

        .module-icon {
            font-size: 2rem;
        }

        .module-title h3 {
            font-size: 1.8rem;
            font-weight: 600;
            color: #2c3e50;
        }

        .module-title p {
            font-size: 1.4rem;
            color: #6c757d;
            margin-top: 0.2rem;
        }

        .command-list {
            display: flex;
            flex-direction: column;
            gap: 1.2rem;
        }

        .command-item {
            display: flex;
            flex-wrap: wrap;
            align-items: baseline;
            gap: 1rem;
            padding: 0.2rem 0;
        }

        .command-cmd {
            min-width: 300px;
        }

        .command-cmd code {
            background: #f8f9fa;
            padding: 0.4rem 1.2rem;
            border-radius: 2rem;
            font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
            font-size: 1.4rem;
            font-weight: 700;
            color: #1e6f5c;
            border: 1px solid #dee2e6;
            white-space: nowrap;
            display: inline-block;
            -webkit-font-smoothing: antialiased;
            text-rendering: optimizeLegibility;
        }

        .command-desc {
            flex: 1;
            font-size: 1.35rem;
            color: #495057;
        }

        .module-note {
            margin-top: 0.8rem;
            padding: 0.6rem 1rem;
            font-size: 1.1rem;
            color: #c7254e;
            background: #fef2f2;
            border-radius: 0.5rem;
            border-left: 3px solid #e74c3c;
        }

        .footer {
            background: #f8f9fa;
            padding: 0.8rem 1.5rem;
            text-align: center;
            font-size: 0.9rem;
            color: #6c757d;
            border-top: 1px solid #e9ecef;
        }

        .footer .powered {
            font-weight: 600;
            color: #2c3e50;
            margin-top: 0.2rem;
        }

        @media (max-width: 640px) {
            body { font-size: 18px; }
            .content { padding: 1rem 1.5rem; }
            .command-cmd { min-width: 100%; }
            .command-cmd code { white-space: normal; word-break: break-word; font-size: 1.2rem; padding: 0.3rem 1rem; }
            .command-desc { font-size: 1.15rem; }
            .module-title h3 { font-size: 1.5rem; }
            .module-title p { font-size: 1.2rem; }
            .header .sub { font-size: 1.2rem; }
            .header { padding: 0.8rem; }
        }
    </style>
</head>
<body>
<div class="container">
    <div class="main-card">
        <div class="header">
            <h1>
                <span>🎬</span>
                FFmpeg Plugin
            </h1>
            <div class="sub">基于 FFmpeg 的 Yunzai-Bot 多媒体处理插件</div>
        </div>
        <div class="content">
            ${modulesHtml}
        </div>
        <div class="footer">
            <div class="powered">生成时间: ${formattedTime}</div>
            <div class="powered">Created By Yunzai-Bot & ffmpeg-plugin</div>
            <div class="powered">💡 提示：所有命令均支持大小写，回复/引用媒体文件可获得更好的体验</div>
            <div class="powered">🔧 需要 ffmpeg 环境支持，请确保已安装 ffmpeg 并加入系统 PATH</div>
        </div>
    </div>
</div>
</body>
</html>`
}

/**
 * 使用框架渲染器将 HTML 转图片消息
 */
async function htmlToImageSegment(html) {
  const templateDir = await ensureTemplateDir()
  const uniq = `${Date.now()}_${Math.random().toString(36).slice(2)}`
  const tplFile = path.join(templateDir, `ffmpeg_help_${uniq}.html`)

  try {
    await fs.writeFile(tplFile, html, 'utf8')
    return await puppeteer.screenshot('ffmpeg-help', {
      tplFile,
      saveId: `help_${uniq}`,
      viewport: { width: 1300, height: 1200 },
      quality: 100
    })
  } finally {
    await fs.unlink(tplFile).catch(() => {})
  }
}

/**
 * 转义 HTML 特殊字符
 */
function escapeHtml(str) {
  if (!str) return ''
  return str.replace(/[&<>]/g, (m) => {
    if (m === '&') return '&amp;'
    if (m === '<') return '&lt;'
    if (m === '>') return '&gt;'
    return m
  })
}

// 防止并发生成帮助图片的标志
let generating = false

export class ffmpegHelp extends plugin {
  constructor() {
    super({
      name: '[ffmpeg-plugin]FFmpeg插件帮助',
      dsc: '#ff帮助 / #ffmpeg-plugin帮助',
      event: 'message.group',
      priority: 100,
      rule: [
        {
          reg: /^#(ff|ffmpeg-plugin)帮助$/i,
          fnc: 'showHelp'
        }
      ]
    })
  }

  async showHelp(e) {
    if (generating) {
      await this.reply('⏳ 正在生成帮助图片，请稍后再试...')
      return false
    }

    generating = true

    try {
      const html = await buildHelpHtml()
      const img = await htmlToImageSegment(html)
      if (!img) {
        await this.reply('❌ 帮助图片生成失败，请稍后再试。', true)
        return false
      }
      await this.reply(img)
    } catch (err) {
      logger.error('[FFmpeg帮助] 生成失败:', err)
      await this.reply(`❌ 生成帮助菜单失败: ${err.message}`, true)
    } finally {
      generating = false
    }
    return true
  }
}