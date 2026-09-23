#!/bin/bash
# Analyze recorded performance log from scripts/monitor-perf.sh
LOG_FILE="$HOME/.config/cinderdeck/logs/perf_session.csv"

if [ ! -f "$LOG_FILE" ]; then
    echo "No log file found at $LOG_FILE. Please run scripts/monitor-perf.sh first."
    exit 1
fi

echo "==========================================="
echo "📊 CINDERDECK USAGE PERFORMANCE ANALYSIS REPORT"
echo "==========================================="

awk -F',' 'NR>1 {
    cpu=$3; ram=$4;
    if (NR==2 || cpu < min_cpu) min_cpu=cpu;
    if (NR==2 || cpu > max_cpu) max_cpu=cpu;
    sum_cpu+=cpu;

    if (NR==2 || ram < min_ram) min_ram=ram;
    if (NR==2 || ram > max_ram) max_ram=ram;
    sum_ram+=ram;
    count++;
}
END {
    if (count > 0) {
        printf "Total Samples Captured: %d (sampling interval ~3s)\n", count;
        printf "-------------------------------------------\n";
        printf "🟢 Min RAM (Idle):     %8.2f MB\n", min_ram;
        printf "🔴 Peak RAM (Active):   %8.2f MB\n", max_ram;
        printf "📈 Avg RAM:             %8.2f MB\n", sum_ram/count;
        printf "-------------------------------------------\n";
        printf "🟢 Min CPU:             %8.2f%%\n", min_cpu;
        printf "🔴 Peak CPU:            %8.2f%%\n", max_cpu;
        printf "📈 Avg CPU:             %8.2f%%\n", sum_cpu/count;
        printf "-------------------------------------------\n";
        
        diff = max_ram - min_ram;
        if (diff > 100) {
            printf "⚠️ Warning: RAM diff between Min and Peak is %.2f MB.\n", diff;
            printf "   Please verify if memory drops back close to %.2f MB when all windows are closed.\n", min_ram;
        } else {
            printf "🟢 Memory range appears stable (Difference: %.2f MB).\n", diff;
        }
    } else {
        print "No valid sample data found in log file.";
    }
}' "$LOG_FILE"
echo "==========================================="
