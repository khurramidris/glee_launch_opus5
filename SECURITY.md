# Security policy

## Supported versions

Security fixes go into the latest release. Please update before reporting.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use this
repository's **Security** tab and choose **Report a vulnerability**.

Include the Glee version, your operating system, the steps to reproduce, and
the impact you expect. Do not include real chat databases, private
conversations, credentials, or other personal data.

We will acknowledge your report, keep you updated while we work on a fix, and
credit you in the release notes if you would like.

## What Glee protects

- The local AI engine listens only on `127.0.0.1`, requires a per-launch secret
  key, and has its web interface and slot inspection endpoints disabled.
- Downloaded AI files are verified against SHA-256 hashes compiled into the app
  before use, and archives are checked for unsafe paths when extracted.
- The app window has a strict content security policy and only the native
  permissions it needs.
