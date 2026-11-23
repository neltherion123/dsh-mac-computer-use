# Third-party software and compatibility

This repository does not distribute DeepSeek Harness, its signed helper, Chrome, Chromium, or macOS frameworks.

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): the plugin integrates with the host's tool, event, and question interfaces. Experimental native operation is compatible with the separately installed DSH Computer Use helper's private protocol (version 1). The baseline inspected and used is DSH 0.2.2-rc.5. The official DSH Computer Use package has its own MIT license and copyright; the helper's upstream notices remain within that helper. None of those notices grant a license to this repository.
- [Chromium](https://www.chromium.org/) and the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/): a locally installed compatible browser is required. The plugin communicates with its own child instance over a private pipe. Browser binaries are not bundled.
- Apple SDK frameworks are linked when the optional local HUD is built on macOS. They are not bundled.

This project is independent and is not endorsed by the upstream projects.
