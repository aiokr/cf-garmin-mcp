# Third-party notices

The project code is MIT licensed. Dependencies keep their own licenses; retain upstream notices when redistributing bundles. Exact versions and transitive dependencies are in pnpm-lock.yaml.

| Project                                          | License                       | Use                                                                   |
| ------------------------------------------------ | ----------------------------- | --------------------------------------------------------------------- |
| Vue / Vue Router / Pinia                         | MIT                           | Web application                                                       |
| Base UI Vue                                      | MIT                           | Accessible unstyled components                                        |
| Lucide                                           | ISC                           | All interface icons and favicon; [notice](third-party/lucide-LICENSE) |
| Better Auth / OAuth Provider                     | MIT                           | Application and OAuth identity                                        |
| Hono / Zod                                       | MIT                           | Routing and input validation                                          |
| fit-file-parser                                  | MIT                           | Strict FIT parser; [notice](third-party/fit-file-parser-LICENSE)      |
| fflate                                           | MIT                           | Bounded ZIP extraction                                                |
| Apache ECharts                                   | Apache-2.0                    | Charts                                                                |
| MapLibre GL JS                                   | BSD-3-Clause                  | Map rendering                                                         |
| MCP TypeScript SDK                               | MIT                           | Streamable HTTP transport                                             |
| Vite / Tailwind CSS / Vitest / ESLint / Prettier | MIT                           | Build and validation                                                  |
| TypeScript                                       | Apache-2.0                    | Type checking                                                         |
| Cloudflare Workers SDK / Wrangler                | MIT or Apache-2.0 per package | Runtime and deployment tools                                          |

Garmin credential protocol implementation references and adapts the MIT-licensed python-garminconnect 0.3.20 (Copyright 2020–2026 Ron Klinkien) and shyim/garmin-cf-mcp at commit 2a93f4bccc1c62cdf4576cc4ad8064c96fd7b4bf (Copyright 2026 shyim). Their complete notices are retained in [third-party/](third-party/). No Python runtime, TLS impersonation or CAPTCHA bypass is included. Garmin FIT SDK is not a dependency; FIT uses the MIT-licensed parser above.

Brand color tokens follow the user-supplied [Tripper Press Color System](https://tripper.press/brand/color). No third-party font or logo is bundled. Map views visibly link © OpenStreetMap contributors; operators must comply with their configured tile provider's usage policy and [OSM Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/).
