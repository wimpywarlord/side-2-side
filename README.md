# Side 2 Side

Local FFmpeg app for placing uploaded videos directly beside each other and rendering a single MP4.

## Run

```bash
npm run dev
```

The app listens on <http://localhost:3020>.

## Render behavior

- Upload two or more videos.
- Choose a row/column layout for a single line or an `N x M` grid, with automatic layouts up to 120 videos.
- Adjust the gap control to add gutter space between assets.
- Use `Fill cells` to remove letterbox seams, or `Full frame` to preserve every source frame without cropping.
- The server scales every input into a fixed 9:16 tile at the selected tile height.
- FFmpeg positions every tile into the selected grid and preserves the configured gap.
- Audio can be copied from the first video or omitted.

## Twitter article thumbnails

- Use **Twitter article thumbnail** to export a 1200×600 PNG from the first frame of each uploaded video.
- The thumbnail uses the selected row/column layout and divides the 2:1 canvas into matching cells and gaps.
