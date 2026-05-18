# Side 2 Side

Local FFmpeg app for placing uploaded videos directly beside each other and rendering a single MP4.

## Run

```bash
npm run dev
```

The app listens on <http://localhost:3020>.

## Render behavior

- Upload two or more videos.
- The server scales every input to the selected output height.
- FFmpeg stacks them with `hstack`, left to right, with no gap.
- Audio can be copied from the first video or omitted.
