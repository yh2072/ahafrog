<p align="center">
  <img src="ahafrog/readme/ahafrog.png" alt="AhaFrog" width="120">
</p>

<p align="center">
  <strong>Turn a PDF or lecture notes into playable browser mini-games.</strong>
</p>

<p align="center">
  <a href="https://github.com/yh2072/ahafrog"><img src="https://img.shields.io/github/stars/yh2072/ahafrog?style=flat-square&label=stars&color=2da44e" alt="GitHub stars" /></a>
  <img src="https://img.shields.io/pypi/v/ahafrog.svg?style=flat-square&label=pypi" alt="PyPI" />
  <img src="https://img.shields.io/badge/python-3.10+-3776AB?style=flat-square" alt="Python 3.10+" />
  <img src="https://img.shields.io/badge/license-AGPL--3.0-orange?style=flat-square" alt="AGPL-3.0" />
</p>

---

## Install

```bash
pip install ahafrog
```

```bash
ahafrog
```

That's it. The Studio opens at **http://localhost:8000** — paste your API key into
the provider box on the page and start.

> You need **Python 3.10+** and an API key from any OpenAI-compatible provider
> ([OpenRouter](https://openrouter.ai) works and is pay-per-use). Nothing else is
> required to get going.

## Use

1. **Paste or drop your material** — text, Markdown, or a PDF. It is parsed on your
   machine; no API call, no upload.
2. **Check the lessons.** AhaFrog splits the material for you; tick the ones you want.
3. **Generate**, then play. Each lesson becomes a mini-game you can open in the browser.

Generation writes to `courses/` in whatever directory you ran `ahafrog` from, so run it
from the same place each time and your courses stay put. A run can be stopped and
resumed — finished lessons are checkpointed and never paid for twice.

![Generated mini-games](ahafrog/readme/showcase.png)

## 中文快速开始

```bash
pip install ahafrog
ahafrog
```

浏览器会打开 **http://localhost:8000**，在页面上的 provider 框里填入 API 密钥即可开始。
粘贴文本、Markdown 或 PDF（**在本地解析，不上传**），勾选要生成的课时，点生成。

生成的课程保存在你运行 `ahafrog` 的那个目录下的 `courses/`，所以每次在同一个目录启动。
生成可以随时停止并续跑，已完成的课时不会重复扣费。

## Optional

| | |
| --- | --- |
| **Node.js 18+** | Generated game code is *executed* in a sandbox and repaired before it ships. Without Node this falls back to a syntax check only — weaker, but it still works. |
| **`.env`** | Put `API_KEY=...` next to where you run `ahafrog` if you would rather not paste it into the page each time. See [`.env.example`](.env.example). |
| **From source** | `git clone https://github.com/yh2072/ahafrog && cd ahafrog && pip install -e . && ahafrog` |

`ahafrog --help` lists the host, port and reload flags.

## More

- [Full documentation](docs/README-full.md) — every option, Conda setup, deployment,
  case studies, and the 中文完整说明
- [Notes for coding agents](AGENTS.md) — architecture, the generation pipeline, the
  sandbox repair loop
- [Commercial licensing](COMMERCIAL.md) — AhaFrog is AGPL-3.0; a commercial option is
  available

---

<p align="center">
  Created by <a href="https://github.com/yh2072">Yuqi Hang</a>
</p>
