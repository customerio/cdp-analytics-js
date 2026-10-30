# Vendored destination bundles

These are the device-mode and cloud `-plugins` destination bundles the
Customer.io edge serves at `/v1/analytics-js/actions/<optionID>.js`. They are
copied **byte for byte** from the `cdp` repository, where they were the only
copy: `edge/api/endpoints/assets/<name>.js` at commit
`cc18b34aa5b350ef311a88b9d3bb6fe6883e5022` (origin/main on 2026-10-29). Every file below
matches the git blob ID of its source (`git hash-object <file>`).

The SDK build (`webpack.config.js`, `PinnedBuildPlugin`) copies them into
`dist/pinned/<version>/actions/` and compiles their SRI hashes into
`analytics.min.js`, so a pinned SDK only runs these exact bytes. Do not edit,
reformat or lint them (`.gitattributes` marks them `-text`); a new or changed
bundle is a new file here, and ships with the next SDK version.

Third-party scripts that a bundle loads itself (for example Meta's
`fbevents.js` from `meta-pixel.js`) are not covered by SRI.

| File | Source blob | Last changed in cdp |
| --- | --- | --- |
| `adobe-target-web.js` | `9973872780a902ce08d9c74da694393a75f70d39` | 1a90108f9 2023-06-05 |
| `amplitude-plugins.js` | `746d2a036677c1578c625b643516ed9c585149d1` | 7f3b0f8ad 2023-03-27 |
| `bing-ads.js` | `7b17bfb811a99d69735d89598c74eac62f955583` | 4d2b1ddc2 2023-06-12 |
| `braze-cloud-plugins.js` | `8217b2661830647f5bf5cacb3e837b93cec56f27` | 7f3b0f8ad 2023-03-27 |
| `braze-web.js` | `089618212bd791eefc3d1c3ec7a01a80ea87fdb1` | 1a90108f9 2023-06-05 |
| `commandbar.js` | `5e464162fc1dfbf8381fb77ebd48d3a4b4923f01` | 7f3b0f8ad 2023-03-27 |
| `friendbuy-web.js` | `8bef60c3aa7f1cca02ef282996627f33cfd51229` | 1a90108f9 2023-06-05 |
| `fullstory-web.js` | `fd96ed63efef7aa7208d81c5488d74a88c071451` | 1a90108f9 2023-06-05 |
| `google-ads.js` | `2acca2df84408cc0cfd88439a3f8fc24126ed4a8` | 262e09567 2023-05-19 |
| `google-analytics-4-web.js` | `bf3aba5a11301df597bb5c8fae3a51c5b4de88dc` | 85ad33c91 2024-03-22 |
| `google-tag-manager.js` | `217e9df4dbf583cb35149cb53b3217db13d2fca7` | f779dbe2a 2024-06-12 |
| `heap-web.js` | `4211f89a6d565924eb820fb7fa55c2d987dfa268` | 1a90108f9 2023-06-05 |
| `hubspot-web.js` | `f79afbc92ce7b16d060c2dcb202542a4513f7b64` | 7f3b0f8ad 2023-03-27 |
| `intercom-web.js` | `941ff4589cf9f82104c1dc02836243bdd655ca76` | 1a90108f9 2023-06-05 |
| `iterate.js` | `5f123773e638664b220483ee850d113d8af403b6` | 7f3b0f8ad 2023-03-27 |
| `koala.js` | `43ca4e55782f29b2b38a037a6d43909915479389` | 7f3b0f8ad 2023-03-27 |
| `logrocket.js` | `beb5ebfc496f0d124db02c9b5b9b509ec0d581af` | 7f3b0f8ad 2023-03-27 |
| `meta-pixel.js` | `8c518c1144525fa45c555faf661560363b91ff48` | 64763cac8 2024-09-23 |
| `playerzero-web.js` | `2e1a4c9c9ece5869af2229260e4a042025ce3a0e` | 7f3b0f8ad 2023-03-27 |
| `ripe-web.js` | `3177d6c41bb2e07d535df540fca7ac8960c7e2c5` | 1a90108f9 2023-06-05 |
| `sabil.js` | `8fc41a978ed067b6cab89e1295fc958db7859199` | 7f3b0f8ad 2023-03-27 |
| `sprig-web.js` | `3c97b6cfddd5ea4e93de8b18a9f2495c66cd0f4c` | 7f3b0f8ad 2023-03-27 |
| `stackadapt.js` | `218e0310384c5ce125c0ae26b2a75d1203ee9db6` | 7f3b0f8ad 2023-03-27 |
| `twitter-pixel.js` | `083d792c2e2e8b0c4818895ef1a9c10f39b4c1b6` | d85043c96 2023-05-30 |
| `vwo-web.js` | `b64ce0f19925fcea92651fd36b15d2c74cfa883d` | 1a90108f9 2023-06-05 |
| `wisepops.js` | `a7f72652783cd853e17c09c6cd7767a239ba631c` | 7f3b0f8ad 2023-03-27 |
