![ffmpeg-plugin](https://socialify.git.ci/anyliew/ffmpeg-plugin/image?description=1&forks=1&issues=1&language=1&name=1&owner=1&pulls=1&stargazers=1&theme=Light)

## 说明

- 本插件为**非原版改造分支**，当前仅适配 **ICQQ**。
- 原版插件仓库：<https://github.com/anyliew/ffmpeg-plugin>

## 功能列表

> ⚠️ 本插件当前为**仅群聊使用**：所有命令仅在群聊消息中触发，私聊不会触发插件命令。

### 📦 更新管理（仅BOT主人可用）
| 命令 | 功能 |
|------|------|
| `#ff更新` / `#ffmpeg-plugin更新` | 检查并更新插件（保留本地修改） |
| `#ff强制更新` | 强制覆盖本地修改，重置到远程最新版本 |

### ℹ️ 版本信息
| 命令 | 功能 |
|------|------|
| `#ff版本` / `#ffmpeg版本` | 生成 FFmpeg 版本信息卡片（包含编译配置、编解码库等） |

### 🎵 媒体信息
| 命令 | 功能 |
|------|------|
| `#音频信息` | 查看音频文件详情（格式、时长、比特率、采样率、声道等） |
| `#图片信息` | 查看图片详情（分辨率、格式、GIF 帧数/帧率等） |
| `#视频信息` | 查看视频详情（编码、分辨率、码率、音频流等） |

> 💡 使用方法：回复/引用包含媒体的消息，或直接发送带有媒体的命令。

### ✂️ 去黑边 / 去白边
| 命令 | 功能 |
|------|------|
| `#去黑边` | 自动检测并裁剪图片/视频四周的黑边 |
| `#去白边` | 自动检测并裁剪图片/视频四周的白边 |

> 💡 支持图片和视频，可批量处理（最多10个）。

### 🛠️ 多媒体工具箱
| 命令 | 功能 |
|------|------|
| `#转动图` / `#转gif` | 将视频转换为 GIF 动图（fps=12，宽度 320，Lanczos 算法） |
| `#动图分解` / `#gif分解` | 将 GIF 动图分解为 PNG 帧序列（合并转发，最多100帧） |
| `#动图打包` / `#gif打包` | 将 GIF 动图的所有帧打包为 ZIP 压缩包（群文件方式发送） |
| `#转语音` | 提取视频中的音频并转换为 MP3 语音消息 |
| `#转mp3` | 将音/视频文件转换为 MP3 音频文件 |
| `#转flac` | 将音/视频文件转换为 FLAC 无损音频文件 |

### ❓ 帮助菜单
| 命令 | 功能 |
|------|------|
| `#ff帮助` / `#ffmpeg-plugin帮助` | 生成帮助菜单图片 |

## 安装

进入 Yunzai-Bot 目录，执行以下命令：

```bash
git clone --depth=1 https://github.com/anyliew/ffmpeg-plugin.git ./plugins/ffmpeg-plugin
cd ./plugins/ffmpeg-plugin
pnpm i
```

## 环境依赖
FFmpeg：必须安装并加入系统 PATH（插件依赖 ffmpeg 和 ffprobe 命令）

Windows：下载 FFmpeg 并配置环境变量

Linux：sudo apt install ffmpeg 或 yum install ffmpeg

macOS：brew install ffmpeg

## 贡献者与致谢

- 原版插件作者与维护者：**anyliew**（<https://github.com/anyliew/ffmpeg-plugin>）
- FFmpeg - 多媒体处理核心