# GitHub Pages 上传与开启方法

推荐使用已经整理好的独立网页发布包，无需 Python、Node、npm 或付费接口。

如果你已经解压独立发布包，当前包含 `index.html` 的目录就是上传目录，直接从第 2 步开始；第 1 步中的路径用于完整开发项目。

## 1. 找到发布文件

- 压缩包：`dist/JetPhotos-Dust-Lab-GitHub-Pages.zip`
- 已解压目录：`dist/github-pages/`
- 重新生成：在项目根目录运行 `python tools/package_web.py`。

ZIP 内的 `index.html` 就在顶层。先解压，上传**里面的文件和 assets 文件夹**，不要上传 ZIP 本身，也不要把外层 `github-pages` 文件夹一起套进去。

上传后的仓库根目录应为：

```text
index.html
styles.css
core.js
jpeg.js
interaction.js
app.js
desktop.js
worker.js
.nojekyll
assets/
  dust_lab.ico
  dust_lab.png
README.md
DEPLOY.md
```

发布包只有程序、素材和说明，没有测试照片、编辑缓存、桌面程序或 Python 环境。

## 2. 新建 GitHub 仓库并上传

1. 登录 GitHub，点击右上角 **+ → New repository**。
2. 仓库名例如 `jetphotos-dust-lab`，选择 **Public**，勾选 **Add a README file**，然后 **Create repository**。免费账户可使用公开仓库发布 Pages。
3. 进入仓库 **Code** 页，选择 **Add file → Upload files**。
4. 打开已解压目录，全选目录内部的文件和 `assets` 文件夹，拖入上传区域。检查 `index.html` 位于根目录，且两个图片文件位于 `assets/`。
5. 提交说明填 `Publish Dust Lab Web`，提交到 `main`（按钮可能显示 **Commit changes**；若选择新分支，则创建并合并 pull request 后再继续）。发布包中的 README 可以覆盖新建仓库时的占位说明。

`.nojekyll` 是一个空文件，用于关闭 Jekyll 处理。若资源管理器未显示它，在仓库根目录选择 **Add file → Create new file**，文件名输入 `.nojekyll`，提交一个空行即可。

## 3. 开启 Pages

1. 进入仓库 **Settings → Pages**。
2. 找到 **Build and deployment**。
3. **Source** 选择 **Deploy from a branch**。
4. **Branch** 选择 **main**，目录选择 **/(root)**，点击 **Save**。若仓库默认分支名称不同，选择实际上传文件的分支。
5. 等待 Pages 部署成功；可在 **Actions** 中查看 **pages build and deployment**。回到 Pages 设置，点击 **Visit site**。

例如仓库为 `jetphotos-dust-lab`，网址通常为：

```text
https://你的GitHub用户名.github.io/jetphotos-dust-lab/
```

首次发布或后续更新可能需要数分钟，官方说明最多可能约 10 分钟。看到旧版时可按 Ctrl F5 强制刷新。若显示 404，先检查部署是否成功、Pages 分支/目录是否正确、`index.html` 是否位于仓库根目录且大小写一致。

## 4. 更新网页

重新生成发布包，把更新后的文件按相同路径上传并提交到 `main`。不要改变 `assets` 等目录结构。Pages 会自动重新部署。用户打开网页后，照片处理在用户自己的浏览器中完成；GitHub 只提供网页程序及素材。

## 5. 使用整个开发仓库时的另一种方式

如果上传的是包含 `web/` 的整个项目，而不是上述独立发布包：

1. 同时保留 `.github/workflows/pages.yml`。
2. **Settings → Pages → Source** 选择 **GitHub Actions**。
3. 在 **Actions** 中运行 **Deploy Dust Lab Web to GitHub Pages → Run workflow**，或推送一次 `web/` 改动。

该工作流部署 `web/`。不要把这套设置与独立发布包的“main / (root)”混用。

## 本地使用与保存说明

网页版无需账号，照片不上传。可以多张导入、仿制修复、撤销/重做并输出原尺寸 JPEG。默认下载到本地；支持目录授权的浏览器还能直接写入用户选择的文件夹。浏览器无法静默获取或写入原片所在目录。

要本地预览独立发布包，在解压目录打开终端执行：

```powershell
python -m http.server 8765 --bind 127.0.0.1
```

访问 `http://127.0.0.1:8765/`。也可从开发项目双击 `start_web.bat`。推荐通过 HTTP/HTTPS 使用，以启用后台 Worker。

本文依据 GitHub 官方文档于 2026-10-28 核对：

- [添加文件到仓库](https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository)
- [配置 GitHub Pages 发布来源](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
- [创建 GitHub Pages 站点](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)
