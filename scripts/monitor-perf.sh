#!/bin/bash
# Monitor Cinderdeck CPU & RAM usage periodically in the background
LOG_DIR="$HOME/.config/cinderdeck/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/perf_session.csv"

echo "Timestamp,PID,CPU_Percent,RAM_MB" > "$LOG_FILE"
echo "Monitoring Cinderdeck CPU & RAM... Press Ctrl+C to stop."
echo "Log file saved to: $LOG_FILE"

while true; do
    PID=$(pgrep -x "Cinderdeck" | head -n 1)
    if [ -n "$PID" ]; then
        TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")
        STATS=$(ps -p "$PID" -o %cpu=,rss= 2>/dev/null)
        if [ -n "$STATS" ]; then
            CPU=$(echo "$STATS" | awk '{print $1}')
            RSS_KB=$(echo "$STATS" | awk '{print $2}')
            RAM_MB=$(echo "scale=2; $RSS_KB / 1024" | bc)
            echo "$TIMESTAMP,$PID,$CPU,$RAM_MB" >> "$LOG_FILE"
        fi
    fi
    sleep 3
done
