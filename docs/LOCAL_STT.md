# Local source transcription

## What it is

Local source transcription is an optional alternative for the spoken-language transcript
in live audio. Gemini continues to produce translated audio and target-language transcripts.
Unset `LOCAL_STT_URL` to use Gemini for the source transcript again.

## Run LocalAI (CPU)

Start the CPU server:

```sh
docker run -p 8080:8080 --name local-ai -ti localai/localai:latest
```

The web UI and API are available at http://localhost:8080. GPU images differ; see the
[LocalAI getting started guide](https://localai.io/docs/basics/getting_started/).

## Install a whisper model

Open http://localhost:8080, go to **Models -> Explore**, search for **whisper**, and click
**Install**. Note the installed model's name; use whatever the Explore page lists.

For a native CLI installation, list available models and install one:

```sh
local-ai models list
local-ai models install <name>
```

As a manual alternative, place a ggml whisper model file from the
[ggerganov/whisper.cpp Hugging Face repository](https://huggingface.co/ggerganov/whisper.cpp)
in LocalAI's models folder and add a YAML configuration like:

```yaml
name: whisper-1
backend: whisper
parameters:
  model: <the downloaded model file name>
```

## Check the server

Before configuring the app, check the transcription API with a sample WAV file:

```sh
curl http://localhost:8080/v1/audio/transcriptions -H "Content-Type: multipart/form-data" \
  -F file="@sample.wav" -F model="<your model name>"
```

It should return JSON with a `"text"` field. LocalAI accepts any ffmpeg-supported audio format.

## Point the app at it

Set these in `.env`, using the model name installed on the server:

```dotenv
LOCAL_STT_URL=http://localhost:8080
LOCAL_STT_MODEL=<your model name>
```

Restart `npm run dev:server`. If the app runs inside Docker Compose, `localhost` means the
container; use `host.docker.internal` (or the host's address) instead.

## Other servers

Any server exposing `POST /v1/audio/transcriptions` with multipart `file` and `model` fields
and a JSON `{ "text": ... }` response works unchanged.

## Known limits

- Only the source transcript is local; translated audio and target-language text still come
  from Gemini.
- Chunk boundaries use naive silence thresholds.
- Local transcription arrives in bursts, not word by word.
- LiveKit credentials are still required for any live-audio test.
