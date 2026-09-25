这个目录是 Playwright 的浏览器缓存（AI 助手的网页操控功能要用）。

里面的文件体积很大，已被 .gitignore 忽略，不会进仓库。

需要时在 app/ 目录执行：

    npx playwright install chromium

程序启动时会优先使用这里的浏览器；没有也能用，只是「网页操控」权限下不能用浏览器自动化。
