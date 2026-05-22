# Side 2 Side

Local FFmpeg app for placing uploaded videos directly beside each other and rendering a single MP4.

## Run

```bash
npm run dev
```

The app listens on <http://localhost:3020>.

## Render behavior

- Upload two or more videos.
- Choose a row/column layout for a single line or an `N x M` grid.
- The server scales every input into a fixed 9:16 tile at the selected tile height.
- FFmpeg stacks each row with `hstack`, then stacks rows with `vstack`.
- Audio can be copied from the first video or omitted.
