# Third-Party Notices

Kotodama does not bundle or redistribute third-party source code. The built extension contains
only this repository's own code.

The following packages are used at build time only and are not part of the built extension:

| Package | License |
| --- | --- |
| [esbuild](https://github.com/evanw/esbuild) | MIT |
| [TypeScript](https://github.com/microsoft/TypeScript) | Apache-2.0 |
| [@types/chrome](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT |

At run time the extension calls the OpenAI API with the user's own API key, and reads caption data
from YouTube pages the user opens. Use of those services is subject to their own terms.
