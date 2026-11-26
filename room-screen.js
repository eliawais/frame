'use strict';

class RoomScreenLink {
  constructor(connection, signal, onChange) {
    this.connection = connection;
    this.pc = connection.peerConnection;
    this.signal = signal;
    this.onChange = onChange;
    this.received = new MediaStream();
    this.transceivers = [];
    this.work = Promise.resolve();
    this.ready = false;
    this.failed = false;
    this.closed = false;
    this.pending = '';
    this.source = null;
    this.packetTimer = null;
    this.handleTrack = ({track}) => {
      if (this.closed || !['video', 'audio'].includes(track.kind)) return;
      for (const previous of this.received.getTracks()) {
        if (previous.kind === track.kind && previous !== track) this.received.removeTrack(previous);
      }
      if (!this.received.getTracks().includes(track)) this.received.addTrack(track);
      const changed = () => this.onChange();
      for (const event of ['unmute', 'mute', 'ended']) track.addEventListener(event, changed);
      this.onChange();
    };
    this.pc.addEventListener('track', this.handleTrack);
    this.connection.on('close', () => this.dispose());
  }

  get playable() {
    return this.ready && this.received.getVideoTracks().some(track => track.readyState === 'live' && !track.muted);
  }

  get sending() {
    return this.ready && this.transceivers.some(({sender}) => sender.track?.kind === 'video' && sender.track.readyState === 'live');
  }

  enqueue(action) {
    this.work = this.work.then(async () => {
      if (!this.closed && this.connection.open) await action();
    }).catch(async () => {
      await this.fail();
    });
    return this.work;
  }

  async fail() {
    if (this.closed || this.failed) return;
    this.failed = true;
    this.ready = false;
    this.pending = '';
    clearTimeout(this.packetTimer);
    try {
      if (this.pc.signalingState === 'have-local-offer') {
        await this.pc.setLocalDescription({type: 'rollback'});
      } else if (this.pc.signalingState === 'have-remote-offer') {
        await this.pc.setRemoteDescription({type: 'rollback'});
      }
    } catch {}
    for (const {sender} of this.transceivers) {
      if (sender.track) sender.replaceTrack(null).catch(() => {});
    }
    this.onChange();
  }

  offer(token) {
    if (this.closed || this.failed || this.pending || this.ready) return;
    this.pending = token;
    this.enqueue(async () => {
      if (this.pc.signalingState !== 'stable') throw Error('Room connection is busy');
      this.transceivers = ['video', 'audio'].map(kind => this.pc.addTransceiver(kind, {direction: 'sendrecv'}));
      await this.pc.setLocalDescription(await this.pc.createOffer());
      this.packetTimer = setTimeout(() => this.enqueue(() => this.fail()), 12000);
      this.signal({type: 'roomScreenOffer', token, sdp: this.pc.localDescription.sdp});
    });
  }

  answerOffer(message) {
    if (this.closed || this.failed || this.ready || this.pending) return;
    this.pending = message.token;
    this.enqueue(async () => {
      if (this.pc.signalingState !== 'stable') throw Error('Room connection is busy');
      await this.pc.setRemoteDescription({type: 'offer', sdp: message.sdp});
      this.transceivers = this.pc.getTransceivers().filter(({receiver}) =>
        ['video', 'audio'].includes(receiver.track.kind));
      for (const slot of this.transceivers) slot.direction = 'sendrecv';
      await this.pc.setLocalDescription(await this.pc.createAnswer());
      this.signal({type: 'roomScreenAnswer', token: message.token, sdp: this.pc.localDescription.sdp});
      this.pending = '';
      this.ready = true;
      await this.updateSenders();
      this.onChange();
    });
  }

  acceptAnswer(message) {
    if (this.closed || this.failed || !this.pending || message.token !== this.pending) return;
    clearTimeout(this.packetTimer);
    this.enqueue(async () => {
      if (this.ready || this.failed || this.pending !== message.token) return;
      await this.pc.setRemoteDescription({type: 'answer', sdp: message.sdp});
      this.pending = '';
      this.ready = true;
      await this.updateSenders();
      this.onChange();
    });
  }

  setSource(stream) {
    this.source = stream;
    if (this.ready && !this.updating) {
      this.updating = true;
      this.enqueue(async () => {
        this.updating = false;
        await this.updateSenders();
      });
    }
  }

  async updateSenders() {
    const tracks = this.source?.getTracks() || [];
    // Attach screen tracks to negotiated senders without creating a new ICE connection.
    await Promise.all(this.transceivers.map(({sender, receiver}) => {
      const track = tracks.find(item => item.kind === receiver.track.kind && item.readyState === 'live') || null;
      return track === sender.track ? undefined : sender.replaceTrack(track);
    }));
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    clearTimeout(this.packetTimer);
    this.pc.removeEventListener('track', this.handleTrack);
  }
}
