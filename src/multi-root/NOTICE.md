# Attribution

The dialect-widening approach in `src/multi-root/dialects.ts` is adapted from
the MIT-licensed community package
[`@dsh-electron/dsh-plugin-multi-root-workspace`](https://github.com/cherrchen/dsh-plugin-multi-root-workspace)
version `0.1.10`:

> MIT License
>
> Copyright (c) 2026 Cherry Chen
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

Only the profile-observation and grant-insertion mechanics were adapted. The
ACP scope, validation, persistence, and provider wiring are original to this
repository; the community package's UI client, LSP, skills, registry, review,
Windows broker, and exact-version allowlist are deliberately not vendored.
