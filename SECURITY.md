# Security policy

## Supported version

The latest commit on `main` is the supported development version. Until a stable release is published, older commits are not maintained as separate security branches.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository. Please include the affected commit, macOS and browser versions, required configuration, impact, and minimal reproduction steps. Do not include real credentials, personal data, or sensitive internal network details.

Please avoid opening a public issue until a fix or safe disclosure plan is available. Ordinary bugs that do not cross a security boundary can use the public issue tracker.

## Security boundaries

- The isolated browser uses a temporary profile and does not inherit the user's normal browser cookies or extensions.
- URL checks block explicit local, private, and link-local addresses, including page requests that expose those literal addresses. They are not a substitute for an egress firewall or isolated network; DNS rebinding and host routing require network-layer controls.
- Native Accessibility support is enabled by default, asks for task-scoped approval before selecting or launching an app, and depends on the separately installed signed DeepSeek Harness helper. It can send input and temporarily use the system clipboard; the helper attempts to restore prior clipboard contents after paste.
- Browser and application content is untrusted input. It does not grant permission to access data or perform an external side effect.
