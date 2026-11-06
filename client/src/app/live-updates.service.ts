import { Injectable, NgZone, inject, signal } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { TOKEN_KEY } from './api.service';

export interface DataChanged {
  kind: string;
  at: string;
}

@Injectable({ providedIn: 'root' })
export class LiveUpdatesService {
  private zone = inject(NgZone);
  private socket: Socket | null = null;
  state = signal<'live' | 'connecting' | 'offline'>('offline');
  authError = signal(false);
  lastEventAt = signal<string | null>(null);

  get label() {
    return this.state() === 'live'
      ? 'Live'
      : this.state() === 'connecting'
        ? 'Connecting'
        : 'Offline';
  }
  get help() {
    if (this.authError())
      return 'Live connection could not authenticate. Sign out and sign in again if your session expired.';
    if (this.state() === 'live')
      return 'Connected. Updates are best effort; network and server delays can occur.';
    if (this.state() === 'connecting')
      return 'Connecting to live updates. You can refresh manually while waiting.';
    return 'Live updates are unavailable. Check your connection or refresh manually; automatic reconnection is best effort.';
  }

  connect(onChange: (event: DataChanged) => void, onConnect: () => void) {
    this.disconnect();
    this.state.set('connecting');
    this.authError.set(false);
    // Relative URL keeps development and deployed connections on the same origin.
    const socket = io({
      autoConnect: false,
      auth: (callback) => callback({ token: localStorage.getItem(TOKEN_KEY) }),
    });
    this.socket = socket;
    socket.on('connect', () =>
      this.zone.run(() => {
        this.state.set('live');
        this.authError.set(false);
        onConnect();
      }),
    );
    socket.on('data:changed', (event: DataChanged) =>
      this.zone.run(() => {
        if (!event || typeof event.kind !== 'string' || typeof event.at !== 'string') return;
        this.lastEventAt.set(event.at);
        onChange(event);
      }),
    );
    socket.on('disconnect', () => this.zone.run(() => this.state.set('offline')));
    socket.on('connect_error', (error: Error) =>
      this.zone.run(() => {
        this.state.set('offline');
        this.authError.set(/auth|token|jwt|expir|unauthor|forbidden/i.test(error.message));
      }),
    );
    socket.io.on('reconnect_attempt', () => this.zone.run(() => this.state.set('connecting')));
    socket.io.on('reconnect_failed', () => this.zone.run(() => this.state.set('offline')));
    socket.connect();
  }

  retry() {
    if (this.socket && !this.socket.connected) {
      this.state.set('connecting');
      this.socket.connect();
    }
  }
  disconnect() {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.io.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
    this.state.set('offline');
    this.authError.set(false);
    this.lastEventAt.set(null);
  }
}
