import express from "express";
import cors from "cors";
import ytdl from "@distube/ytdl-core";
import fs, { stat } from "fs";
import filenamify from "filenamify";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import ffmpegProbe from "ffprobe-static";
import path from "path";
import { fileURLToPath } from "url";
import progress from "progress-stream";
import { WebSocketServer } from "ws";
import { customAlphabet } from "nanoid";
import { PassThrough } from "stream";

ffmpeg.setFfprobePath(ffmpegProbe.path);
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const wss = new WebSocketServer({ port: 8080 });

let mergeWeight = 0.2;
const connections = new Map();
let activeDownloads = new Map();

const alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

app.use(
  cors({
    exposedHeaders: ["File-Name"],
    origin: "*",
    methods: "*",
    credentials: true,
  })
);
app.use(express.json());

function deleteFile(filePath) {
  fs.unlink(filePath, (err) => {
    if (err) {
      console.error(`Failed to delete file: ${filePath}`, err);
    } else {
      console.log(`Deleted file: ${filePath}`);
    }
  });
}

function sendFile(response, path, title) {
  response.set({ "file-name": encodeURIComponent(title) });

  response.download(path, (error) => {
    if (error) {
      console.log(error);
      res.status(500).json({ error });
    } else {
      deleteFile(path);
    }
  });
}

function downloadStream(url, outputPath, format, id, type) {
  return new Promise((resolve, reject) => {
    const fileSize = parseInt(format.contentLength, 10);
    const download = activeDownloads.get(getSocket(id));
    download.totalSize += fileSize;

    const str = progress({
      length: fileSize,
      time: 50 /* ms */,
    });

    str.on("progress", (progress) => {
      const download = activeDownloads.get(getSocket(id));
      download.completedSize += progress.delta;
      updateProgress(id);
    });

    const stream = ytdl(url, { format });
    const passThroughStream = new PassThrough();

    let tempWs = connections.get(id);
    activeDownloads.set(tempWs, {
      ...activeDownloads.get(tempWs),
      [type === "video" ? "videoStream" : "audioStream"]: stream,
      [type === "video" ? "passThroughVideo" : "passThroughAudio"]:
        passThroughStream,
    });
    console.log("stream");
    const file = fs.createWriteStream(outputPath);
    stream.pipe(passThroughStream).pipe(str).pipe(file);
    passThroughStream.on("close", () => {
      console.log("cencelled passthrough");
    });
    file.on("close", () => {
      console.log("cancelled");
    });
    file.on("finish", resolve);
    file.on("error", reject);
  });
}

function getSocket(id) {
  return connections.get(id);
}

function updateProgress(id) {
  const { totalSize, completedSize, mergeProgress } = activeDownloads.get(
    getSocket(id)
  );
  const percentage = totalSize
    ? ((completedSize / totalSize) * (1 - mergeWeight) +
        mergeProgress * mergeWeight) *
      100
    : mergeProgress * 100;
  console.log("progress", percentage);
  connections.get(id)?.send(JSON.stringify({ type: "PROGRESS", percentage }));
}

app.post("/download", async (req, res) => {
  const { url, format, id } = req.body;
  const info = await ytdl.getInfo(url);
  const videoTitle = info.videoDetails.title;
  const fileName = filenamify(videoTitle);
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const outputPath = path.resolve(__dirname);
  const videoPath = path.resolve(outputPath, `video-${id}.mp4`);
  const audioPath = path.resolve(outputPath, `audio-${id}.mp3`);
  const socket = getSocket(id);
  let outputFilePath;
  activeDownloads.set(socket, {
    ...activeDownloads.get(socket),
    totalSize: 0,
    completedSize: 0,
    mergeProgress: 0,
  });

  const videoFormat = ytdl.chooseFormat(info.formats, {
    quality: "highestvideo",
  });
  const audioFormat = ytdl.chooseFormat(info.formats, {
    quality: "highestaudio",
  });

  if (format === "audio") {
    outputFilePath = path.resolve(outputPath, `output-${id}.mp3`);
    activeDownloads.set(socket, {
      ...activeDownloads.get(socket),
      filePaths: [videoPath, audioPath, outputFilePath],
    });

    downloadStream(url, outputFilePath, audioFormat, id, "audio")
      .then(() => {
        console.log("finish");
        activeDownloads.delete(connections.get(id));
        sendFile(res, outputFilePath, `${fileName}.mp3`);
      })
      .catch((err) => {
        console.log(err);
      });
  } else {
    outputFilePath = path.resolve(outputPath, `output-${id}.mp4`);
    activeDownloads.set(socket, {
      ...activeDownloads.get(socket),
      filePaths: [videoPath, audioPath, outputFilePath],
    });

    const videoDownload = downloadStream(
      url,
      videoPath,
      videoFormat,
      id,
      "video"
    );
    const audioDownload = downloadStream(
      url,
      audioPath,
      audioFormat,
      id,
      "audio"
    );

    // Wait for both downloads to finish
    await Promise.all([videoDownload, audioDownload]);

    // Merge video and audio
    const ffmpegCommand = ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .audioCodec("aac")
      .videoCodec("copy")
      .outputOptions(["-c:v copy", "-c:a aac", "-strict experimental"])
      .on("progress", (progress) => {
        const download = activeDownloads.get(getSocket(id));
        download.mergeProgress =
          progress.percent > 0
            ? progress.percent / 100
            : download.mergeProgress;
        updateProgress(id);
      })
      .on("end", () => {
        console.log("Download and merge completed");
        deleteFile(videoPath);
        deleteFile(audioPath);
        activeDownloads.delete(connections.get(id));
        sendFile(res, outputFilePath, `${fileName}.mp4`);
      })
      .on("error", (err) => {
        console.error("Error during merging:", err);
      });

    activeDownloads.set(socket, {
      ...activeDownloads.get(socket),
      ffmpeg: ffmpegCommand,
    });

    ffmpegCommand.save(outputFilePath);
  }
});

app.listen(5000, () => {
  console.log("Listening at http://localhost:5000");
});

wss.on("connection", (ws) => {
  const nanoid = customAlphabet(alphabet, 5);
  const id = nanoid();
  console.log("New client connected");
  connections.set(id, ws);
  ws.send(JSON.stringify({ type: "USER_ID", id }));

  ws.on("message", (message) => {
    const data = JSON.parse(message);
    console.log(data, "data");
  });

  ws.on("close", () => {
    for (let [key, value] of connections) {
      if (value === ws) {
        const download = activeDownloads.get(value);
        if (download) {
          download.videoStream?.destroy();
          download.audioStream?.destroy();
          download.passThroughVideo?.destroy();
          download.passThroughAudio?.destroy();
          download.ffmpeg?.kill();
          download.filePaths.forEach((path) => {
            deleteFile(path);
          });
          activeDownloads.delete(value);
        }
        connections.delete(key);
        break;
      }
    }
  });
});

export default app;
