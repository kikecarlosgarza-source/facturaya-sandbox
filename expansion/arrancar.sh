#!/usr/bin/env bash
# Arranca guardian (--watch, ciclo 6h) y scout_continuo (--watch, ciclo 1h)
# como procesos de fondo bajo `caffeinate -i` para que la Mac no entre en
# idle sleep. Logs en ./logs/, PIDs en ./pids/. Idempotente: si el proceso
# ya está vivo según el pidfile, no lo duplica.
#
# Uso:
#   bash backend/expansion/arrancar.sh         # arranca lo que falte
#   bash backend/expansion/arrancar.sh detener # detiene ambos
#   bash backend/expansion/arrancar.sh estado  # muestra estado y últimas líneas

set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$DIR/logs"
PID_DIR="$DIR/pids"
mkdir -p "$LOG_DIR" "$PID_DIR"

start_one() {
  local name="$1"
  local script="$2"
  local pidfile="$PID_DIR/$name.pid"
  local logfile="$LOG_DIR/$name.log"

  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "[$name] ya corriendo (pid=$(cat "$pidfile"))"
    return
  fi

  # nohup + & deja el proceso vivo aunque cierres la terminal.
  # caffeinate -i evita idle sleep mientras node esté corriendo.
  nohup caffeinate -i node "$DIR/$script" --watch >> "$logfile" 2>&1 &
  local pid=$!
  echo "$pid" > "$pidfile"
  disown 2>/dev/null || true
  echo "[$name] arrancado (pid=$pid) → $logfile"
}

stop_one() {
  local name="$1"
  local pidfile="$PID_DIR/$name.pid"
  if [ ! -f "$pidfile" ]; then
    echo "[$name] sin pidfile"
    return
  fi
  local pid
  pid="$(cat "$pidfile")"
  if kill -0 "$pid" 2>/dev/null; then
    # Mata caffeinate y su hijo node (mismo grupo de proceso bajo nohup).
    kill "$pid" 2>/dev/null || true
    pkill -P "$pid" 2>/dev/null || true
    echo "[$name] detenido (pid=$pid)"
  else
    echo "[$name] pid=$pid no estaba vivo"
  fi
  rm -f "$pidfile"
}

estado_one() {
  local name="$1"
  local pidfile="$PID_DIR/$name.pid"
  local logfile="$LOG_DIR/$name.log"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "[$name] vivo (pid=$(cat "$pidfile")) — log: $logfile"
  else
    echo "[$name] no corre"
  fi
  if [ -f "$logfile" ]; then
    echo "  últimas 3 líneas:"
    tail -n 3 "$logfile" | sed 's/^/    /'
  fi
}

cmd="${1:-arrancar}"
case "$cmd" in
  arrancar|start|"")
    start_one guardian       guardian.js
    start_one scout_continuo scout_continuo.js
    echo
    echo "Listo. Para seguir:"
    echo "  tail -f $LOG_DIR/guardian.log"
    echo "  tail -f $LOG_DIR/scout_continuo.log"
    echo "Para detener: bash $0 detener"
    ;;
  detener|stop)
    stop_one guardian
    stop_one scout_continuo
    ;;
  estado|status)
    estado_one guardian
    estado_one scout_continuo
    ;;
  *)
    echo "Uso: $0 [arrancar|detener|estado]"
    exit 1
    ;;
esac
