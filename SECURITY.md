# Security Policy

## Reporting a vulnerability

Please do not open a public issue for security problems.

Use GitHub's private vulnerability reporting: open the **Security** tab of this repository and
click **Report a vulnerability**.

Include what you found, how to reproduce it, and the affected version or commit. You can expect a
first response within a week. This is a personal project, so fixes are made on a best-effort basis.

## Supported versions

Only the latest commit on the `main` branch is supported.

## Scope notes

- The extension stores the OpenAI API key unencrypted in the extension's local storage. This is a
  known and documented design choice for a personal-use tool.
- Reports about the third-party services the extension talks to (OpenAI, YouTube) should go to
  those services.
