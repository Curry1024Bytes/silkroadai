# Seedance 2.0 视频生成 — 接入指南

> 适用对象:Silk Road AI 客户。
> 适用模型:`seedance-2.0`、`seedance-2.0-fast`、`seedance-2.0-1080p`
> 接口风格:OpenAI 兼容(任何能发 HTTP 请求的工具 / 语言都能调)。
> 本指南覆盖四种玩法:**文生视频**、**图生视频**、**首尾帧视频**、**参考生视频**。

---

## 一、开始之前:3 个固定信息

调用任何接口都先准备好这三样:

| 项目                   | 值                               | 说明                             |
| ---------------------- | -------------------------------- | -------------------------------- |
| **接口地址(Base URL)** | `https://ai.silkroadai.io/v1`    | 所有请求的前缀                   |
| **令牌(API Key)**      | 你的令牌(形如 `sk-xxxxxx`)       | 在 portal 后台「API 密钥」页创建 |
| **鉴权方式**           | `Authorization: Bearer 你的令牌` | 放在 HTTP Header 里              |

> ⚠️ 令牌 = 钱包,**不要泄露、不要写进前端网页源码**。请在你自己的服务器后端调用,前端只调你自己的服务。

---

## 二、核心流程:所有视频都是「两步走」

Seedance 是**异步生成** —— 不是发一个请求就立刻拿到视频,而是:

```
第 1 步:创建任务  →  拿到 任务ID (task_id)
第 2 步:轮询任务  →  拿到 视频URL(生成需要几十秒到几分钟)
```

### 第 1 步:创建任务

```
POST https://ai.silkroadai.io/v1/video/generations
```

返回示例:

```json
{ "task_id": "task_xxx", "object": "video", "status": "queued", "progress": 10 }
```

把 `task_id` 记下来,后面轮询要用。(个别客户端字段名可能是 `id`,代码里 `task_id` 取不到时兜底取一下 `id` 更稳。)

### 第 2 步:轮询查结果

```
GET https://ai.silkroadai.io/v1/video/generations/{task_id}
```

每隔 **3~5 秒**查一次(1080p 更慢,可拉到 10 秒),直到状态变为成功:

| 状态字段                               | 含义            | 你该做什么            |
| -------------------------------------- | --------------- | --------------------- |
| `queued` / `SUBMITTED` / `IN_PROGRESS` | 排队中 / 生成中 | 继续等待,几秒后再查   |
| `SUCCESS`                              | 成功 ✅         | 从返回里取视频地址    |
| `FAILURE`                              | 失败 ❌         | 看 `fail_reason` 排查 |

**取视频地址**:我们的返回里,视频直链在 **`data.data.video_url`**(公网 `.mp4`,浏览器可直接播放)。

成功返回示例:

```json
{
    "status": "SUCCESS",
    "data": {
        "data": {
            "video_url": "https://.../result.mp4?sign=xxx"
        }
    }
}
```

> 💡 保险写法:如果你不想写死路径,可以**递归扫整个返回 JSON**,按 `video_url > download_url > url > result_url` 的优先级,取第一个以 `http` 开头的字段(见第四节 Python 示例)。优先用内层 `video_url`(带签名的源文件直链)。
>
> ⚠️ **视频直链是临时签名链接(实测约 24 小时后失效)**。拿到后**尽快下载转存到你自己的对象存储 / 图床**,不要长期引用这个链接。

---

## 三、四种玩法

下面所有示例都用 **curl**,复制后把 `你的令牌` 和图片地址换成自己的即可。

参数说明(四种玩法共用):

| 参数               | 类型   | 必填   | 说明                                                                |
| ------------------ | ------ | ------ | ------------------------------------------------------------------- |
| `model`            | 字符串 | ✅     | `seedance-2.0` / `seedance-2.0-fast` / `seedance-2.0-1080p`         |
| `prompt`           | 字符串 | ✅     | 画面描述,**最长 2000 字符**                                         |
| `duration`         | 整数   | 否     | 视频秒数,**最小 4 秒**(默认 4)                                      |
| `image`            | 字符串 | 看玩法 | 首帧图(https 链接或 base64 的 dataURL)。**只能是字符串,不能传数组** |
| `last_frame_image` | 字符串 | 看玩法 | 尾帧图(配合 `image` 做首尾帧,见玩法 3)                              |
| `reference_images` | 数组   | 看玩法 | 参考图,**最多 4 张**                                                |

**进阶可选字段(随模型透传,不填走默认即可):** `resolution`(分辨率)、`aspect_ratio`(画幅比例,如 `16:9` / `9:16` / `1:1`)、`fps`(帧率)、`camera_fixed`(固定机位)、`generate_audio`(是否生成音频)、`reference_video`(参考视频)。取值遵循 Seedance 模型规范。

---

### 玩法 1️⃣:文生视频(纯文字 → 视频)

最基础:只给文字描述,模型自由发挥。

```bash
curl -X POST https://ai.silkroadai.io/v1/video/generations \
  -H "Authorization: Bearer 你的令牌" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "seedance-2.0",
    "prompt": "一只橘猫在洒满阳光的窗台上伸懒腰,慢镜头,电影感,暖色调",
    "duration": 5
  }'
```

> 💡 纯文生比带图玩法**慢不少**(常见 3~6 分钟),偶发上游 `504` 时**重试即可**(见第六节)。需要更快、更可控时,给一张首帧图走玩法 2。

---

### 玩法 2️⃣:图生视频(一张图 → 让它动起来)

给一张图作为**首帧**,模型让画面动起来。适合:让一张海报 / 插画 / 角色图变成动态视频。

**关键字段:`image`**(首帧图)

```bash
curl -X POST https://ai.silkroadai.io/v1/video/generations \
  -H "Authorization: Bearer 你的令牌" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "seedance-2.0",
    "prompt": "镜头缓缓推进,少女的头发被风轻轻吹动,眼神望向远方",
    "duration": 5,
    "image": "https://你的图床.com/girl.png"
  }'
```

`image` 支持两种写法:

- **网络图片链接**:`"image": "https://.../girl.png"`(推荐,省流量)
- **base64 内嵌**:`"image": "data:image/png;base64,iVBORw0KG..."`(图片没有公网链接时用)

> 💡 提示词建议只写「**动作 / 镜头运动 / 氛围**」,画面内容已经由首帧图决定了,不用再描述长相。

---

### 玩法 3️⃣:首尾帧视频(给开头和结尾 → 自动补中间过程)

给**第一帧**和**最后一帧**两张图,模型自动生成中间的过渡动画。适合:精确控制视频的起止画面(如角色从坐到站、镜头从近到远)。

**关键字段:首帧用 `image`,尾帧用 `last_frame_image`**(两个都传**字符串**,不是数组)。

```bash
curl -X POST https://ai.silkroadai.io/v1/video/generations \
  -H "Authorization: Bearer 你的令牌" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "seedance-2.0",
    "prompt": "镜头从全景平滑过渡到特写,光线由明转暗",
    "duration": 5,
    "image": "https://你的图床.com/first.png",
    "last_frame_image": "https://你的图床.com/last.png"
  }'
```

> 📌 **首尾两张图最好分辨率、画幅一致**,否则过渡会变形。

---

### 玩法 4️⃣:参考生视频(给参考图 → 保持人物 / 风格一致)

给 1~4 张**参考图**,模型在生成时保持参考图里的**角色长相 / 物体 / 画风**一致。适合:让同一个角色出现在不同镜头里不变样。

**关键字段:`reference_images`**(数组,最多 4 张)

```bash
curl -X POST https://ai.silkroadai.io/v1/video/generations \
  -H "Authorization: Bearer 你的令牌" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "seedance-2.0",
    "prompt": "这个女孩穿着红色连衣裙在花园里奔跑,阳光明媚",
    "duration": 5,
    "reference_images": [
      "https://你的图床.com/role-front.png",
      "https://你的图床.com/role-side.png"
    ]
  }'
```

> 💡 **图生 vs 参考生 的区别**:
>
> - **图生**(`image`):这张图就是视频的**第一帧**,画面从它开始动。
> - **参考生**(`reference_images`):这些图**不直接出现在画面里**,只是告诉模型「人 / 物长这样」,画面由 prompt 重新构图。
>
> 两者可以**同时用**:`image` 定首帧 + `reference_images` 锁角色一致性。

---

## 四、完整示例:创建 + 轮询(Python)

把整个「两步走」串起来,开箱即用:

```python
import requests, time

BASE = "https://ai.silkroadai.io/v1"
KEY  = "你的令牌"
HEADERS = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}

# 第 1 步:创建任务(这里演示图生视频)
resp = requests.post(f"{BASE}/video/generations", headers=HEADERS, json={
    "model": "seedance-2.0",
    "prompt": "镜头缓缓推进,头发被风吹动",
    "duration": 5,
    "image": "https://你的图床.com/girl.png",
})
resp.raise_for_status()
task_id = resp.json().get("task_id") or resp.json().get("id")
print("任务已创建:", task_id)

# 第 2 步:每 5 秒轮询一次,最多等 5 分钟
def pick_url(d):
    """递归找视频地址,按优先级返回"""
    found = {"video_url": None, "download_url": None, "url": None, "result_url": None}
    def walk(n):
        if isinstance(n, dict):
            for k in found:
                if not found[k] and isinstance(n.get(k), str) and n[k].startswith("http"):
                    found[k] = n[k]
            for v in n.values(): walk(v)
        elif isinstance(n, list):
            for v in n: walk(v)
    walk(d)
    return found["video_url"] or found["download_url"] or found["url"] or found["result_url"]

for _ in range(60):  # 60 次 × 5 秒 = 5 分钟
    r = requests.get(f"{BASE}/video/generations/{task_id}", headers=HEADERS).json()
    status = str(r.get("status") or r.get("data", {}).get("status") or "").upper()
    if status in ("FAILURE", "FAILED", "ERROR"):
        raise RuntimeError("生成失败:" + str(r.get("fail_reason") or r))
    url = pick_url(r)
    if url:
        print("✅ 视频地址:", url)
        break
    print("⏳ 生成中…", status)
    time.sleep(5)
else:
    print("超时,请稍后再查任务", task_id)
```

JavaScript(Node.js)版思路相同:`fetch` 创建任务拿 `task_id` → 定时轮询 `GET` → 拿到 `video_url` 即停止。

---

## 五、参数速查表

| 玩法     | 必给字段                                | 效果                |
| -------- | --------------------------------------- | ------------------- |
| 文生视频 | `prompt`                                | 纯文字生成          |
| 图生视频 | `prompt` + `image`                      | 图片作首帧动起来    |
| 首尾帧   | `prompt` + `image` + `last_frame_image` | 给定起止画面补中间  |
| 参考生   | `prompt` + `reference_images`           | 锁定角色 / 风格一致 |

| 模型                 | 分辨率 | 价格(按秒) | 5 秒 / 15 秒  |
| -------------------- | ------ | ---------- | ------------- |
| `seedance-2.0`       | ≤ 720P | ¥0.04 / 秒 | ¥0.20 / ¥0.60 |
| `seedance-2.0-fast`  | 480P   | ¥0.04 / 秒 | ¥0.20 / ¥0.60 |
| `seedance-2.0-1080p` | 1080P  | ¥0.12 / 秒 | ¥0.60 / ¥1.80 |

> 按视频**实际时长(秒)**计费,`duration` 控制秒数(默认 4 秒)。三个模型同一接口,只改 `model` 即可。

---

## 六、常见问题排查

| 现象                          | 原因 / 解决                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| **401 / 鉴权失败**            | 令牌错了或没带 `Bearer ` 前缀;检查 `Authorization` 头                                  |
| **404**                       | 用错了端点 —— 视频走 `/v1/video/generations`,**不是** `/v1/chat/completions`           |
| **duration 报错 / 被改成 4**  | 秒数小于 4,最小就是 4 秒                                                               |
| **prompt 被截断**             | 超过 2000 字符会被截掉,精简提示词                                                      |
| **首尾帧字段报 Unsupported**  | 尾帧字段名是 `last_frame_image`(**不是** `image_tail`);`image` 只能传字符串,不能传数组 |
| **视频地址播不出来**          | 用了需要鉴权 / 失败时塞了错误串的 `result_url`;改用内层 `data.data.video_url`          |
| **视频链接失效**              | 第三方直链是临时签名链接(**约 24 小时**),**拿到后尽快下载转存到自己图床 / 对象存储**   |
| **任务一直 IN_PROGRESS 很久** | 高峰期排队正常,**纯文生最慢(3~6 分钟)**、1080p 更慢;耐心轮询,别频繁重建任务            |
| **504 / 5xx / 429**           | 上游波动或限流(**纯文生偶发** `504`);**重试**通常即可,或改用带首帧图的玩法更稳         |

---

## 七、一句话总结

> **图生** = 给一张图当开头,让它动;
> **首尾生** = 给开头和结尾两张图,AI 补中间;
> **参考生** = 给几张参考图,锁住人物长相不跑偏。
> 所有玩法都是「**先 POST 创建任务拿 `task_id`,再 GET 轮询拿视频链接**」,记得拿到链接尽快转存。

---

_接口字段均经平台后端真机实测(2026-06-15):文生 / 图生(`image`)/ 首尾帧(`image` + `last_frame_image`)/ 参考生(`reference_images`,≤4 张)四种玩法均已跑通出片。`image` 与 `last_frame_image` 只接受字符串(传数组报 400);视频直链约 24h 失效,请及时转存。_
