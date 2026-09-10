/**
 * The subset of the XVIZ v2 wire format this Worker emits.
 *
 * XVIZ is the protocol streetscape.gl speaks; the schema lives at
 * https://github.com/aurora-opensource/xviz. These are hand-written rather than
 * generated because the Worker only ever *writes* XVIZ, and writing needs a
 * fraction of the schema that reading does — declaring just that fraction keeps
 * the encoder honest about what it produces and adds no runtime dependency to
 * the Worker bundle.
 *
 * Field names are snake_case because that is what goes on the wire.
 */
/* eslint-disable camelcase */

export type XVIZColor = string | [number, number, number] | [number, number, number, number];

/** A named rule in a stream's stylesheet, selected by a primitive's `base.classes`. */
export interface XVIZStyleClass {
  name: string;
  style: Record<string, unknown>;
}

export interface XVIZStreamMetadata {
  category: "POSE" | "PRIMITIVE" | "VARIABLE" | "TIME_SERIES" | "FUTURE_INSTANCE" | "UI_PRIMITIVE";
  primitive_type?: "POINT" | "POLYGON" | "POLYLINE" | "CIRCLE" | "TEXT" | "STADIUM" | "IMAGE";
  scalar_type?: "FLOAT" | "INT32" | "STRING" | "BOOL";
  /** Absent means IDENTITY: the stream is in the log's own metre grid. */
  coordinate?: "IDENTITY" | "GEOGRAPHIC" | "VEHICLE_RELATIVE" | "DYNAMIC";
  units?: string;
  stream_style?: Record<string, unknown>;
  style_classes?: XVIZStyleClass[];
}

/** One entry in a declarative-UI panel; `XVIZPanel` renders these by `type`. */
export interface XVIZUIComponent {
  type: "panel" | "container" | "metric" | "plot" | "table" | "treetable" | "video";
  name?: string;
  title?: string;
  description?: string;
  layout?: "vertical" | "horizontal";
  streams?: string[];
  stream?: string;
  children?: XVIZUIComponent[];
}

export interface XVIZMetadata {
  version: "2.0.0";
  streams: Record<string, XVIZStreamMetadata>;
  ui_config?: Record<string, XVIZUIComponent>;
  log_info: { start_time: number; end_time: number };
}

export interface XVIZPose {
  timestamp: number;
  map_origin: { longitude: number; latitude: number; altitude: number };
  /** Metres east/north/up of `map_origin`. */
  position: [number, number, number];
  /** Radians: roll, pitch, yaw. */
  orientation: [number, number, number];
}

/** Per-primitive identity, styling and style-class selection. */
export interface XVIZPrimitiveBase {
  object_id?: string;
  classes?: string[];
  style?: Record<string, unknown>;
}

export interface XVIZPolygon {
  base?: XVIZPrimitiveBase;
  vertices: number[][];
}

export interface XVIZPolyline {
  base?: XVIZPrimitiveBase;
  vertices: number[][];
}

export interface XVIZCircle {
  base?: XVIZPrimitiveBase;
  center: number[];
  radius: number;
}

export interface XVIZText {
  base?: XVIZPrimitiveBase;
  position: number[];
  text: string;
}

/**
 * Point clouds ship as flattened arrays: `points` is xyz-interleaved and
 * `colors` is rgba-interleaved. The four-channel form is deliberate — the
 * viewer infers the colour format from the buffer length, and a three-channel
 * buffer is read back as RGBA.
 */
export interface XVIZPointCloud {
  base?: XVIZPrimitiveBase;
  points: number[];
  colors: number[];
}

export interface XVIZPrimitiveSet {
  polygons?: XVIZPolygon[];
  polylines?: XVIZPolyline[];
  circles?: XVIZCircle[];
  texts?: XVIZText[];
  points?: XVIZPointCloud[];
}

export interface XVIZTimeSeriesEntry {
  timestamp: number;
  streams: string[];
  values: { doubles?: number[]; int32s?: number[]; strings?: string[]; bools?: boolean[] };
  object_id?: string;
}

export interface XVIZTreeTableColumn {
  display_text: string;
  type: "string" | "int32" | "double" | "boolean";
}

export interface XVIZTreeTableNode {
  id: number;
  parent?: number;
  column_values?: (string | number | boolean | null)[];
}

export interface XVIZUIPrimitiveSet {
  treetable?: { columns: XVIZTreeTableColumn[]; nodes: XVIZTreeTableNode[] };
}

export interface XVIZStreamSet {
  timestamp: number;
  poses: Record<string, XVIZPose>;
  primitives?: Record<string, XVIZPrimitiveSet>;
  time_series?: XVIZTimeSeriesEntry[];
  ui_primitives?: Record<string, XVIZUIPrimitiveSet>;
}

export interface XVIZStateUpdate {
  update_type: "snapshot" | "incremental" | "complete_state" | "persistent";
  updates: XVIZStreamSet[];
}

/** Every XVIZ message on the wire is one of these envelopes. */
export type XVIZEnvelope =
  | { type: "xviz/metadata"; data: XVIZMetadata }
  | { type: "xviz/state_update"; data: XVIZStateUpdate }
  | { type: "xviz/transform_log_done"; data: { id: string } }
  | { type: "xviz/error"; data: { message: string } };

/** What a client sends us. Only `transform_log` changes what we stream. */
export interface XVIZTransformLog {
  id?: string;
  start_timestamp?: number;
  end_timestamp?: number;
}
