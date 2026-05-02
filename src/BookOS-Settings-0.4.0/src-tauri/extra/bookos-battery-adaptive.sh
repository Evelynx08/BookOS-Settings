#!/bin/bash
# BookOS Adaptive Charging — stops charging at predicted disconnect time.
# Called by bookos-battery-adaptive.timer every minute.
# Reads the charge_limit from /etc/bookos/charge_limit (written by the app).
# Uses /var/log/bookos/battery.csv predictions to decide when to re-enable charging.

LIMIT_FILE="/etc/bookos/charge_limit"
CSV="/var/log/bookos/battery.csv"

# Charge limit set by app (default 80)
LIMIT=80
[ -f "$LIMIT_FILE" ] && LIMIT=$(cat "$LIMIT_FILE" 2>/dev/null | tr -d '[:space:]')
[[ "$LIMIT" =~ ^[0-9]+$ ]] || LIMIT=80

# Find battery
BAT=""
for b in BAT0 BAT1; do
    [ -f "/sys/class/power_supply/$b/capacity" ] && BAT="$b" && break
done
[ -z "$BAT" ] && exit 0

LEVEL=$(cat "/sys/class/power_supply/$BAT/capacity" 2>/dev/null) || exit 0
STATUS=$(cat "/sys/class/power_supply/$BAT/status" 2>/dev/null || echo "Unknown")
LIMIT_PATH="/sys/class/power_supply/$BAT/charge_control_end_threshold"

[ ! -w "$LIMIT_PATH" ] && exit 0

# Current time in minutes since midnight
DOW=$(date +%u)
NOW_MINS=$(( 10#$(date +%H) * 60 + 10#$(date +%M) ))

# Parse today's median disconnect time from CSV
PREDICT_MINS=""
if [ -f "$CSV" ]; then
    # Find transitions Charging/Full → Discharging for today's weekday
    # Quick awk: collect disconnect times for DOW, compute median
    PREDICT_MINS=$(awk -F',' -v dow="$DOW" '
        NR==1 { next }
        { day=$1; h=$2; m=$3; st=$5 }
        prev_day==dow && (prev_st=="Charging" || prev_st=="Full") && day==dow && st=="Discharging" {
            times[n++] = h*60+m
        }
        { prev_day=day; prev_st=st }
        END {
            if (n==0) { print ""; exit }
            # bubble sort (small n)
            for (i=0;i<n;i++) for (j=i+1;j<n;j++) if (times[j]<times[i]) { t=times[i]; times[i]=times[j]; times[j]=t }
            print times[int(n/2)]
        }
    ' "$CSV")
fi

# Decision logic:
# If we know when the user typically unplugs and that time is within 90 min,
# cap charging at current level or LIMIT, whichever is lower.
# Otherwise apply the configured LIMIT.

TARGET=$LIMIT

if [ -n "$PREDICT_MINS" ] && [ "$PREDICT_MINS" -gt 0 ] 2>/dev/null; then
    MINS_UNTIL=$(( PREDICT_MINS - NOW_MINS ))
    # Handle midnight wrap
    [ "$MINS_UNTIL" -lt -120 ] && MINS_UNTIL=$(( MINS_UNTIL + 1440 ))

    if [ "$MINS_UNTIL" -ge 0 ] && [ "$MINS_UNTIL" -le 90 ]; then
        # Approaching predicted unplug — cap at current level + small buffer
        SMART=$(( LEVEL + 5 ))
        [ "$SMART" -lt 20 ] && SMART=20
        [ "$SMART" -gt "$LIMIT" ] && SMART=$LIMIT
        TARGET=$SMART
    fi
fi

# Write threshold only if it changed (avoid unnecessary sysfs writes)
CURRENT=$(cat "$LIMIT_PATH" 2>/dev/null)
if [ "$CURRENT" != "$TARGET" ]; then
    echo "$TARGET" > "$LIMIT_PATH"
fi
