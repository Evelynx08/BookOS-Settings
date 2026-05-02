#!/bin/bash
# BookOS battery CSV logger
# Appends one row to /var/log/bookos/battery.csv every time it runs.
# Designed to be called by a systemd timer every 30 seconds.
# Format: dia_semana,hora,minuto,nivel,estado,power_uw
# dia_semana: 1=Mon ... 7=Sun (matches JS getDay() converted)

CSV="/var/log/bookos/battery.csv"
MAXLINES=60000   # keep ~3 weeks of 30-sec samples

# Ensure directory and file exist with header
mkdir -p /var/log/bookos
if [ ! -f "$CSV" ]; then
    echo "dia_semana,hora,minuto,nivel,estado,power_uw" > "$CSV"
fi

# Read battery info
BAT=""
for b in BAT0 BAT1; do
    [ -f "/sys/class/power_supply/$b/capacity" ] && BAT="$b" && break
done
[ -z "$BAT" ] && exit 0

LEVEL=$(cat "/sys/class/power_supply/$BAT/capacity" 2>/dev/null) || exit 0
STATUS=$(cat "/sys/class/power_supply/$BAT/status" 2>/dev/null || echo "Unknown")
# Power en µW = current_now(µA) * voltage_now(µV) / 1_000_000
_CUR=$(cat "/sys/class/power_supply/$BAT/current_now" 2>/dev/null || echo 0)
_VOL=$(cat "/sys/class/power_supply/$BAT/voltage_now" 2>/dev/null || echo 0)
POWER=$(( _CUR * _VOL / 1000000 ))

# Day of week: date +%u gives 1=Mon...7=Sun
DOW=$(date +%u)
HOUR=$(date +%H | sed 's/^0//')
MIN=$(date +%M | sed 's/^0//')

echo "$DOW,$HOUR,$MIN,$LEVEL,$STATUS,$POWER" >> "$CSV"

# Trim to MAXLINES (keep header + last MAXLINES-1 data rows)
LINES=$(wc -l < "$CSV")
if [ "$LINES" -gt "$MAXLINES" ]; then
    HEADER=$(head -1 "$CSV")
    TAIL=$(tail -n $((MAXLINES - 1)) "$CSV")
    printf '%s\n%s\n' "$HEADER" "$TAIL" > "$CSV"
fi
