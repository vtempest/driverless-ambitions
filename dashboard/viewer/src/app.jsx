/* global window */
import React, {PureComponent} from 'react';

import {
  LogViewer,
  MeterWidget,
  PlaybackControl,
  StreamSettingsPanel,
  TurnSignalWidget,
  VIEW_MODE,
  XVIZPanel
} from 'streetscape.gl';
import {Form, ThemeProvider} from '@streetscape.gl/monochrome';
import {setXVIZConfig} from '@xviz/parser';

import {APP_SETTINGS, CAR, LEGEND, LIDAR_DENSITIES, MAPBOX_TOKEN, MAP_STYLE, THEME, XVIZ_CONFIG, XVIZ_STYLE} from './constants';
import {TRANSPORTS, createLoader, fetchLogs} from './log-source';

setXVIZConfig(XVIZ_CONFIG);

/**
 * XVIZ loaders invoke listeners as `callback(eventType, payload)`, and the
 * payload is whatever went wrong: an `Error`, a DOM event from the socket, or a
 * parsed XVIZ message the loader could not use (type `INCOMPLETE` or `ERROR`,
 * with the reason in `message`). Flatten all three into one line for the badge.
 */
function describeError(payload) {
  if (!payload) return 'unknown error';
  if (payload.message) return String(payload.message);
  if (payload.type) return `loader rejected a ${payload.type} message`;
  return String(payload);
}

/** The Worker timestamps logs in wall-clock seconds. */
const formatTimestamp = seconds => new Date(seconds * 1000).toISOString().slice(11, 22) + ' UTC';

export default class App extends PureComponent {
  state = {
    logs: null,
    logId: null,
    transport: 'file',
    lidar: '0.35',
    log: null,
    status: 'connecting',
    error: null,
    settings: {viewMode: 'PERSPECTIVE', showTooltip: true}
  };

  componentDidMount() {
    fetchLogs().then(
      logs => {
        // A ?log= in the address bar wins, so a screenshot or a bug report can
        // point at one scene.
        const requested = new window.URLSearchParams(window.location.search).get('log');
        const logId = logs.some(l => l.log_id === requested) ? requested : logs[0].log_id;
        this.setState({logs}, () => this._open(logId));
      },
      error => this.setState({status: 'error', error: error.message})
    );
  }

  componentWillUnmount() {
    this._close();
  }

  _close() {
    if (this.state.log) {
      this.state.log.close();
    }
  }

  /** Tear down the current loader and connect a new one. */
  _open(logId, overrides = {}) {
    const {logs} = this.state;
    const transport = overrides.transport || this.state.transport;
    const lidar = overrides.lidar || this.state.lidar;
    const entry = logs.find(l => l.log_id === logId);
    if (!entry) {
      return;
    }

    this._close();

    let log;
    try {
      log = createLoader(entry, transport, lidar);
    } catch (error) {
      this.setState({status: 'error', error: error.message});
      return;
    }

    log
      .on('error', (type, payload) => this.setState({status: 'error', error: describeError(payload)}))
      .on('ready', () => this.setState({status: 'ready', error: null}))
      .on('update', () => {
        if (this.state.status === 'loading') {
          this.setState({status: 'ready'});
        }
      })
      .connect();

    this.setState({logId, transport, lidar, log, status: 'loading', error: null});

    const url = new window.URL(window.location.href);
    url.searchParams.set('log', logId);
    window.history.replaceState(null, '', url);
  }

  _onLogChange = event => this._open(event.target.value);
  _onTransportChange = event => this._open(this.state.logId, {transport: event.target.value});
  _onLidarChange = event => this._open(this.state.logId, {lidar: event.target.value});
  _onSettingsChange = changed => this.setState({settings: {...this.state.settings, ...changed}});

  _selectedLog() {
    const {logs, logId} = this.state;
    return logs && logs.find(l => l.log_id === logId);
  }

  _renderHeader() {
    const {logs, logId, transport, lidar, status, error} = this.state;
    return (
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <div className="brand-name">OA Driverless Vision · XVIZ viewer</div>
            <div className="brand-sub">streetscape.gl over XVIZ served from Cloudflare Workers</div>
          </div>
        </div>

        <label className="control">
          Log
          <select value={logId || ''} onChange={this._onLogChange} disabled={!logs}>
            {(logs || []).map(log => (
              <option key={log.log_id} value={log.log_id}>
                {log.name}
              </option>
            ))}
          </select>
        </label>

        <label className="control">
          Transport
          <select value={transport} onChange={this._onTransportChange} disabled={!logs}>
            {Object.keys(TRANSPORTS).map(key => (
              <option key={key} value={key}>
                {TRANSPORTS[key]}
              </option>
            ))}
          </select>
        </label>

        <label className="control">
          Lidar
          <select value={lidar} onChange={this._onLidarChange} disabled={!logs}>
            {LIDAR_DENSITIES.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <span className="badge" data-state={status} title={error || undefined}>
          {error ? `error · ${error}` : status}
        </span>
        <a className="control" href="/">
          Back to Atlas
        </a>
      </header>
    );
  }

  _renderSidebar() {
    const {log} = this.state;
    const entry = this._selectedLog();
    return (
      <aside className="sidebar">
        {entry && (
          <div className="scene-card">
            <h2>Scene</h2>
            <strong>{entry.name}</strong>
            <p>{entry.description}</p>
            <dl className="scene-facts">
              <dt>Visibility</dt>
              <dd className="mono">{entry.odd.visibility_class}</dd>
              <dt>Lighting</dt>
              <dd className="mono">{entry.odd.lighting_class}</dd>
              <dt>Route</dt>
              <dd className="mono">{entry.odd.route_class}</dd>
              <dt>Duration</dt>
              <dd className="mono">
                {entry.duration_s} s · {entry.frames} frames @ {entry.hz} Hz
              </dd>
              <dt>Lidar range</dt>
              <dd className="mono">{entry.lidar_range_m} m</dd>
              <dt>Actors</dt>
              <dd className="mono">{entry.actors}</dd>
            </dl>
          </div>
        )}

        <XVIZPanel log={log} name="Metrics" />
        <XVIZPanel log={log} name="Events" />

        <div>
          <h2>View</h2>
          <Form data={APP_SETTINGS} values={this.state.settings} onChange={this._onSettingsChange} />
        </div>

        <div>
          <h2>Streams</h2>
          <StreamSettingsPanel log={log} />
        </div>
      </aside>
    );
  }

  render() {
    const {log, status, error, settings} = this.state;

    if (status === 'error' && !log) {
      return (
        <ThemeProvider theme={THEME}>
          <div className="shell">
            {this._renderHeader()}
            <div className="notice error">
              <p>{error}</p>
              <p className="muted">
                The viewer reads <code>/api/xviz/logs</code> from the Atlas Worker. In development, start it with{' '}
                <code>npm run dev</code> in <code>dashboard/</code> so the Vite proxy has something to reach.
              </p>
            </div>
          </div>
        </ThemeProvider>
      );
    }

    return (
      <ThemeProvider theme={THEME}>
        <div className="shell">
          {this._renderHeader()}
          <div className="body">
            {this._renderSidebar()}
            <div className="stage">
              <div className="map">
                {log && (
                  <LogViewer
                    log={log}
                    car={CAR}
                    xvizStyles={XVIZ_STYLE}
                    showTooltip={settings.showTooltip}
                    viewMode={VIEW_MODE[settings.viewMode]}
                    // Without a Mapbox token there is no basemap to draw, and
                    // asking react-map-gl for one would only log a 401.
                    showMap={Boolean(MAPBOX_TOKEN)}
                    mapboxApiAccessToken={MAPBOX_TOKEN}
                    mapStyle={MAP_STYLE}
                  />
                )}
                {/* The HUD widgets take `log` as a required prop and read
                    its stream metadata straight away, so they only mount once
                    a loader exists. */}
                {log && (
                  <div className="hud">
                    <TurnSignalWidget log={log} streamName="/vehicle/turn_signal" />
                    <hr />
                    <MeterWidget log={log} streamName="/vehicle/velocity" label="Speed" units="m/s" min={0} max={16} />
                    <hr />
                    <MeterWidget
                      log={log}
                      streamName="/vehicle/acceleration"
                      label="Accel"
                      units="m/s²"
                      min={-6}
                      max={4}
                      getWarning={x => (x < -3 ? 'HARD BRAKE' : '')}
                    />
                  </div>
                )}
                <div className="legend">
                  {LEGEND.map(item => (
                    <div key={item.label}>
                      <span className="swatch" style={{background: item.color}} />
                      <span className="muted">{item.label}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="timeline">
                <PlaybackControl width="100%" log={log} formatTimestamp={formatTimestamp} />
              </div>
            </div>
          </div>
        </div>
      </ThemeProvider>
    );
  }
}
