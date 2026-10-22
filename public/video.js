// Video calls at the table. Every pair of players gets a direct WebRTC connection;
// the server only relays the setup messages. Uses the standard "perfect negotiation"
// pattern so either side can turn their camera on or off at any time.
const Video = (() => {
  let socket = null;
  let myId = null;
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  let localStream = null;
  let camFlags = {};          // player id -> { session, cam } from the server
  const peers = new Map();    // player id -> peer
  const videos = new Map();   // player id -> <video>
  let needsUnmute = false;    // browser blocked sound until the user clicks something
  let onChange = () => {};    // a remote video started: the seats need redrawing

  fetch('/config').then((r) => r.json()).then((c) => (iceServers = c.iceServers)).catch(() => {});

  function play(v) {
    v.play().catch(() => {
      // Autoplay with sound is blocked until the page is clicked: play muted for now.
      if (!v.muted) {
        v.muted = true;
        v.dataset.unmuteLater = '1';
        needsUnmute = true;
        v.play().catch(() => {});
      }
    });
  }
  document.addEventListener('click', () => {
    if (!needsUnmute) return;
    needsUnmute = false;
    for (const v of videos.values()) {
      if (v.dataset.unmuteLater) { v.muted = false; delete v.dataset.unmuteLater; }
    }
  });

  function videoFor(id) {
    let v = videos.get(id);
    if (!v) {
      v = document.createElement('video');
      v.autoplay = true;
      v.playsInline = true;
      videos.set(id, v);
    }
    return v;
  }

  function attachLocal(peer) {
    if (!localStream) return;
    for (const track of localStream.getTracks()) {
      // Reuse the same sender when the camera comes back on, so no new negotiation is needed.
      if (peer.senders[track.kind]) peer.senders[track.kind].replaceTrack(track);
      else peer.senders[track.kind] = peer.pc.addTrack(track, localStream);
    }
  }

  function closePeer(id) {
    const peer = peers.get(id);
    if (!peer) return;
    peer.pc.close();
    peers.delete(id);
    videos.get(id)?.remove();
    videos.delete(id);
  }

  function createPeer(id, session) {
    closePeer(id);
    const pc = new RTCPeerConnection({ iceServers });
    const peer = { pc, session, polite: myId < id, makingOffer: false, ignoreOffer: false, senders: {}, stream: new MediaStream() };
    peers.set(id, peer);
    const signal = (data) => socket.emit('rtc', { to: id, data });

    pc.onicecandidate = ({ candidate }) => candidate && signal({ candidate });
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        signal({ description: pc.localDescription });
      } catch (e) {
        console.warn(e);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.ontrack = ({ track }) => {
      if (!peer.stream.getTracks().includes(track)) peer.stream.addTrack(track);
      const v = videoFor(id);
      if (v.srcObject !== peer.stream) v.srcObject = peer.stream;
      play(v);
      onChange();
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') pc.restartIce();
    };
    attachLocal(peer);
    return peer;
  }

  async function onSignal({ from, session, data }) {
    const known = camFlags[from]?.session;
    if (known && known !== session) return; // a message from their previous connection
    let peer = peers.get(from);
    if (!peer || peer.session !== session) peer = createPeer(from, session);
    const { pc } = peer;
    try {
      if (data.description) {
        const d = data.description;
        const collision = d.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;
        await pc.setRemoteDescription(d);
        if (d.type === 'offer') {
          await pc.setLocalDescription();
          socket.emit('rtc', { to: from, data: { description: pc.localDescription } });
        }
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (e) {
          if (!peer.ignoreOffer) console.warn(e);
        }
      }
    } catch (e) {
      console.warn(e);
    }
  }

  return {
    init(s, changed) {
      socket = s;
      onChange = changed;
      socket.on('rtc', onSignal);
      // After a reconnect everyone sees a new session for us, so start every connection fresh.
      socket.on('connect', () => [...peers.keys()].forEach(closePeer));
    },

    // Keep one connection per connected player; rebuild it if they reconnected.
    sync(state) {
      myId = state.you;
      camFlags = state.video;
      for (const [id, info] of Object.entries(camFlags)) {
        if (id === myId) continue;
        const peer = peers.get(id);
        if (!peer || peer.session !== info.session) createPeer(id, info.session);
      }
      for (const id of [...peers.keys()]) if (!camFlags[id]) closePeer(id);
    },

    // Who should show video on their seat.
    isOn(id) {
      return id === myId ? Boolean(localStream) : Boolean(camFlags[id]?.cam && peers.get(id)?.stream.getVideoTracks().length);
    },

    // Move the (long-lived) video elements into the freshly rendered seat slots.
    mount() {
      document.querySelectorAll('[data-cam]').forEach((slot) => {
        const v = videos.get(slot.dataset.cam);
        if (v && v.parentNode !== slot) {
          slot.appendChild(v);
          play(v);
        }
      });
    },

    async startCamera() {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15 } },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      for (const peer of peers.values()) attachLocal(peer);
      const v = videoFor(myId);
      v.muted = true; // never play your own voice back
      v.classList.add('mirror');
      v.srcObject = localStream;
      socket.emit('cam', { on: true });
    },

    stopCamera() {
      if (!localStream) return;
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
      for (const peer of peers.values()) {
        for (const sender of Object.values(peer.senders)) sender.replaceTrack(null);
      }
      videos.get(myId)?.remove();
      videos.delete(myId);
      socket.emit('cam', { on: false });
    },

    get cameraOn() { return Boolean(localStream); },
    get micOn() { return Boolean(localStream?.getAudioTracks().some((t) => t.enabled)); },
    toggleMic() {
      const on = !this.micOn;
      localStream?.getAudioTracks().forEach((t) => (t.enabled = on));
    },

    streamFor(id) {
      return id === myId ? localStream : peers.get(id)?.stream;
    },

    leave() {
      this.stopCamera();
      [...peers.keys()].forEach(closePeer);
    },
  };
})();
