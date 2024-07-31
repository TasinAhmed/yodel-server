import express from "express";
import cors from "cors";
import ytdl from "@distube/ytdl-core";
import fs from "fs";
import filenamify from "filenamify";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import path from "path";
import { fileURLToPath } from "url";

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();

app.use(cors({ exposedHeaders: ["File-Name"] }));
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

function downloadStream(url, outputPath, format) {
  return new Promise((resolve, reject) => {
    const stream = ytdl(url, { format });
    const file = fs.createWriteStream(outputPath);
    stream.pipe(file);
    file.on("finish", resolve);
    file.on("error", reject);
  });
}

app.post("/download", async (req, res) => {
  const { url, format } = req.body;
  console.log(url);
  const info = await ytdl.getInfo(url);
  const videoTitle = info.videoDetails.title;
  const fileName = filenamify(videoTitle);
  console.log(fileName);
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const outputPath = path.resolve(__dirname);
  const videoPath = path.resolve(outputPath, "video.mp4");
  const audioPath = path.resolve(outputPath, "audio.mp3");
  let outputFilePath;

  const videoFormat = ytdl.chooseFormat(info.formats, {
    quality: "highestvideo",
  });
  const audioFormat = ytdl.chooseFormat(info.formats, {
    quality: "highestaudio",
  });

  if (format === "audio") {
    outputFilePath = path.resolve(outputPath, `output.mp3`);
    await ytdl(url, { format: audioFormat })
      .pipe(fs.createWriteStream(outputFilePath))
      .on("close", () => {
        sendFile(res, outputFilePath, `${fileName}.mp3`);
      });
  } else {
    outputFilePath = path.resolve(outputPath, `output.mp4`);

    const videoDownload = downloadStream(url, videoPath, videoFormat);
    const audioDownload = downloadStream(url, audioPath, audioFormat);

    // Wait for both downloads to finish
    await Promise.all([videoDownload, audioDownload]);

    // Merge video and audio
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .audioCodec("aac")
      .videoCodec("copy")
      .outputOptions(["-c:v copy", "-c:a aac", "-strict experimental"])
      .save(outputFilePath)
      .on("end", () => {
        console.log("Download and merge completed");
        deleteFile(videoPath);
        deleteFile(audioPath);
        sendFile(res, outputFilePath, `${fileName}.mp4`);
      })
      .on("error", (err) => {
        console.error("Error during merging:", err);
      });
  }
});

app.listen(5000, () => {
  console.log("Listening at http://localhost:5000");
});
