---
"shemcp": patch
---

Fix PR #42 review comments for shell pagination and spill file handling

- **Fixed `read_file_chunk` memory usage**: Now reuses range reader instead of loading entire spill files into RAM
- **Fixed `readFileRange` edge case**: Added proper handling for `end <= start` to avoid ERR_OUT_OF_RANGE errors
- **Improved file size detection**: Uses `statSync` to get file size without reading content into memory
- **Enhanced error handling**: Better bounds checking and validation for pagination parameters