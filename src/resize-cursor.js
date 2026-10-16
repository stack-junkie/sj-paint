// CSS provides four undirected resize axes. Geometry owners supply a screen
// direction; quantization is presentation only and never changes the gesture.
export function resizeCursor([x, y]) {
  const axis = ((Math.round(Math.atan2(y, x) / (Math.PI / 4)) % 4) + 4) % 4;
  return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][axis];
}
