import React from "react";
import classes from "./index.module.css";
import Message from "./components/message";
import Progress from "./components/progress";
import IconButton from "./components/iconbutton";
import Microphone from "./components/microphone";
import MicrophoneOff from "./components/microphoneOff";
import D3Graph from "./components/d3Graph";

import AnimatedBars from "./components/animatedBars";

import getFilesFromUpload from "./lib/upload";
import audioInstance from "./components/audioInstance";
require('dotenv').config();

const sendData = async (file, options, signal) => {
  let formData = new FormData();
  formData.append("file", file);
  formData.append("options", JSON.stringify(options));

  try {
    const resp = await fetch("/api/transcribe", {
      method: "POST",
      headers: {
        Accept: "application/json",
      },
      body: formData,
      signal: signal,
    });

    return await resp.json();
  } catch (err) {
    console.log(err);
  }
};

const formatData = (data) => {
  return data.split("\n");
};

export async function getServerSideProps(context) {
  const files = getFilesFromUpload();

  return {
    props: { prev: files },
  };
}

class Page extends React.Component {
  constructor(props) {
    super(props);

    this.audioRef = React.createRef();
    this.scrollableBoxRef = React.createRef(); // Add ref for the scrollable box

    this.state = {
      data: this.props.prev || [],

      graph: {
        nodes: [],
        links: []
      },

      progress: 0,
      selected: "",
      error: false,
      started: false,
      sendStatus: 0,

      recording: false,
      countDown: false,
      count: 0,

      openDialog: false,
      duration: 5,
      model: "tiny",
      language: "Japanese",
      task: "translate",

      playDuration: 0,
      minDecibels: -50,
      maxPause: 500,
    };

    this.mediaRec = null;
    this.chunks = [];

    this.MAX_COUNT = 10;
    this.MIN_DECIBELS = -45;
    this.MAX_PAUSE = 3000;

    this.animFrame = null;
    this.countTimer = null;
    this.audioDomRef = null;
    this.abortController = null;

    this.handlePlay = this.handlePlay.bind(this);
    this.handleStart = this.handleStart.bind(this);

    this.handleStream = this.handleStream.bind(this);
    this.handleError = this.handleError.bind(this);
    this.handleData = this.handleData.bind(this);
    this.handleStop = this.handleStop.bind(this);
  }

  textCompilation(n) {
    const allTexts = [];

    this.state.data.forEach((item) => {
      allTexts.push(item.texts.join(" "));
    });

    if (allTexts.length <= n) {
      return allTexts.join(" ");
    } else {
      return allTexts.slice(-n).join("");
    }
  }

  async componentDidUpdate(prevProps, prevState) {
    if (prevState.data !== this.state.data) {
      const last_resp = this.textCompilation(1)
      const corpus = this.textCompilation(20)

      if (last_resp.split(" ").length <= 3 || corpus.split(" ").length <= 3) {
        console.log("Error: not updating");
        return;
      }
      const resp = await audioInstance(corpus, this.state.graph);

      if (resp?.error === -1) {
        console.log("Error: not updating");
        return;
      } else {
        console.log("Success: updating"); 
        this.setState({ graph: resp });
      }

      // Scroll to bottom after updating state with new data
      this.scrollToBottom();
    }
  }

  componentWillUnmount() {
    window.cancelAnimationFrame(this.animFrame);

    if (this.abortController) {
      this.abortController.abort();
    }
  }

  componentDidMount() {
    try {
      let rawdata = localStorage.getItem("yaph-settings");
      if (rawdata) {
        const options = JSON.parse(rawdata);

        this.setState({
          duration: parseInt(options.duration),
          model: options.model,
          language: options.language,
          task: options.task,
          minDecibels: options.hasOwnProperty("minDecibels")
            ? parseInt(options.minDecibels)
            : this.MIN_DECIBELS,
          maxPause: options.hasOwnProperty("maxPause")
            ? parseInt(options.maxPause)
            : this.MAX_PAUSE,
        });
      }
    } catch (err) {
      console.log(err);
    }

    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      const options = { audio: true };
      navigator.mediaDevices
        .getUserMedia(options)
        .then(this.handleStream)
        .catch(this.handleError);
    } else {
      console.log("Media devices not supported");

      this.setState({
        error: true,
      });
    }

    this.abortController = new AbortController();
  }

  handleUpdateOptions({ duration, model, language, task, minDecibels, maxPause }) {
    let options = {
      duration: this.state.duration,
      model: this.state.model,
      language: this.state.language,
      task: this.state.task,
      minDecibels: this.state.minDecibels,
      maxPause: this.state.maxPause,
    };

    if (maxPause) {
      this.setState({ maxPause: parseInt(maxPause) });
      options.maxPause = parseInt(maxPause);
    }

    if (minDecibels) {
      this.setState({ minDecibels: parseInt(minDecibels) });
      options.minDecibels = parseInt(minDecibels);
    }

    if (duration) {
      this.setState({ duration: duration });
      options.duration = duration;
    }

    if (model) {
      this.setState({ model: model });
      options.model = model;
    }

    if (language) {
      this.setState({ language: language });
      options.language = language;
    }

    if (task) {
      this.setState({ task: task });
      options.task = task;
    }

    localStorage.setItem("yaph-settings", JSON.stringify(options));
  }

  handleError(error) {
    console.log(error);
    this.setState({ error: true });
  }

  handleStream(stream) {
    this.mediaRec = new MediaRecorder(stream, { mimeType: "audio/webm" });
    this.mediaRec.addEventListener("dataavailable", this.handleData);
    this.mediaRec.addEventListener("stop", this.handleStop);
    this.checkAudioLevel(stream);
  }

  checkAudioLevel(stream) {
    const audioContext = new AudioContext();
    const audioStreamSource = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.maxDecibels = -10;
    analyser.minDecibels = this.state.minDecibels;
    audioStreamSource.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const domainData = new Uint8Array(bufferLength);

    const detectSound = () => {
      let soundDetected = false;
      analyser.getByteFrequencyData(domainData);

      for (let i = 0; i < bufferLength; i++) {
        if (domainData[i] > 0) {
          soundDetected = true;
        }
      }

      if (soundDetected === true) {
        if (this.state.recording) {
          if (this.state.countDown) {
            clearInterval(this.countTimer);
            this.setState({ countDown: false, count: 0 });
          }
        } else {
          if (this.state.started) {
            this.setState({ countDown: false, recording: true, count: 0 });
            this.mediaRec.start();
          }
        }
      } else {
        if (this.state.recording) {
          if (this.state.countDown) {
            if (this.state.count >= this.state.maxPause) {
              if (this.state.started) {
                clearInterval(this.countTimer);
                this.setState({ countDown: false, count: 0, recording: false });
                this.mediaRec.stop();
              }
            }
          } else {
            this.setState({ count: 0, countDown: true });
            this.startCountDown();
          }
        }
      }

      this.animFrame = window.requestAnimationFrame(detectSound);
    };

    this.animFrame = window.requestAnimationFrame(detectSound);
  }

  startCountDown() {
    this.countTimer = setInterval(() => {
      this.setState((prev) => {
        return { ...prev, count: prev.count + 100 };
      });
    }, 100);
  }

  handleData(e) {
    this.chunks.push(e.data);
  }

  sendAudioData(file) {
    this.setState((prev) => {
      return { ...prev, sendStatus: prev.sendStatus + 1 };
    });

    sendData(
      file,
      {
        model: this.state.model,
        language: this.state.language,
        task: this.state.task,
      },
      this.abortController.signal
    )
      .then((resp) => {
        const _status = resp.status;
        const _file = resp.file?.filename;
        const _url = resp.file?.path;
        const _out = resp.out;
        if (_status === 200) {
          const items = formatData(_out);

          if (items.length > 0) {
            let d = this.state.data.slice(0);

            d.push({
              id: _file,
              url: _url.replace("public/", "/"),
              texts: items,
            });

            this.setState((prev) => {
              let c = prev.sendStatus - 1;
              return { ...prev, data: d, sendStatus: c < 0 ? 0 : c };
            });

            return;
          }
        }

        this.setState((prev) => {
          let c = prev.sendStatus - 1;
          return { ...prev, sendStatus: c < 0 ? 0 : c };
        });
      })
      .catch((error) => {
        console.log(error);
      });
  }

  handleStop() {
    const blob = new Blob(this.chunks, { type: "audio/webm;codecs=opus" });
    this.chunks = [];
    
    const file = new File([blob], `file${Date.now()}.m4a`);
    
    this.sendAudioData(file);
  }

  async getDuration(id) {
    this.audioDomRef.currentTime = 0;
    this.audioDomRef.removeEventListener("timeupdate", this.getDuration);

    if (this.audioDomRef.duration === Infinity) {
      console.log("[Error] Cannot play audio data");
      return;
    }

    this.setState({ playDuration: this.audioDomRef.duration, selected: id });

    try {
      await this.audioDomRef.play();
    } catch (err) {
      console.log(err);
    }

    setTimeout(() => {
      this.audioDomRef.remove();
      this.audioDomRef = null;
      this.setState({ selected: "" });
    }, Math.round(this.audioDomRef.duration * 1000));
  }

  async handlePlay(id) {
    if (this.state.selected) return;

    const selitem = this.state.data.find((item) => item.id === id);

    this.audioDomRef = new Audio();
    this.audioDomRef.type = "audio/mp4";

    this.audioDomRef.addEventListener("loadedmetadata", async () => {
      if (this.audioDomRef.duration === Infinity) {
        this.audioDomRef.currentTime = 1e101;
        this.audioDomRef.addEventListener("timeupdate", this.getDuration(id));
      } else {
        this.setState({ playDuration: this.audioDomRef.duration, selected: id });

        try {
          await this.audioDomRef.play();
        } catch (err) {
          console.log(err);
        }

        setTimeout(() => {
          this.audioDomRef.remove();
          this.audioDomRef = null;
          this.setState({ selected: "" });
        }, Math.round(this.audioDomRef.duration * 1000));
      }
    });

    this.audioDomRef.src = selitem.url;
  }

  handleStart() {
    if (this.state.error) return;

    if (this.state.started) {
      clearInterval(this.countTimer);

      try {
        if (this.state.recording) {
          this.mediaRec.stop();
        }
      } catch (err) {
        console.log(err);
      }

      this.setState({ recording: false, countDown: false, count: 0, progress: 0, started: false });
    } else {
      this.setState({ progress: 0, started: true });
    }
  }

  scrollToBottom() {
    if (this.scrollableBoxRef.current) {
      this.scrollableBoxRef.current.scrollTop = this.scrollableBoxRef.current.scrollHeight;
    }
  }

  render() {
    const display_data = this.state.data.sort((a, b) => {
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });

    return (
      <div className={classes.container}>
        <div className={classes.title}>yaph</div>
        {this.state.data.length == 0 ? (
          <div className={classes.defaultScreen}>
            <h2>Please hit the record button to graph ideas in real-time!</h2>
          </div>
        ) : 
        <div className={classes.panelMessages}>
          <D3Graph graph={{
            nodes: this.state.graph.nodes,
            links: this.state.graph.links
          }}></D3Graph>
        </div>
  }
        <div className={classes.panelControl}>
          <div className={classes.panelLeft}></div>
          <div className={classes.panelCenter}>
            <div className={classes.scrollableBox} ref={this.scrollableBoxRef}>
              {display_data.map((item) => {
                return (
                  <Message
                  key={item.id}
                  duration={this.state.playDuration}
                  id={item.id}
                  texts={item.texts}
                  mode={this.state.selected.length > 0 && this.state.selected === item.id ? 1 : 0}
                  onClick={this.handlePlay}
                  />
                  );
                })}
            </div>
            <div className={classes.centerContainer}>
              <div className={classes.progress}>
                <Progress value={this.state.progress} backgroundColor="#333" displayOff={true} lineWidth={5} />
              </div>
              <div
                className={classes.buttonCenter}
                style={{
                  borderColor: this.state.started ? "#FF0A0A" : "#4AD2EE",
                  backgroundColor: this.state.started ? "#FF0A0A" : "#4AD2EE",
                }}
                >
                <IconButton onClick={this.handleStart} size={32}>
                  {this.state.error ? (
                    <MicrophoneOff color="#555" />
                    ) : (
                      <Microphone
                      color={this.state.started ? "#FFFFFF" : "#555"}
                      />
                      )}
                </IconButton>
              </div>
              {this.state.started && (
                <div className={classes.soundLevel}>
                  <AnimatedBars start={this.state.recording} />
                </div>
              )}
            </div>
          </div>
          <div className={classes.panelRight}>
            <div className={classes.period}>{this.state.duration}s</div>
          </div>
        </div>
        <audio ref={this.audioRef} controls style={{ display: "none" }}></audio>
      </div>
    );
  }
}

export default Page;
