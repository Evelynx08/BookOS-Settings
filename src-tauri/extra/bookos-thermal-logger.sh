#!/bin/sh
# bookos-thermal-logger.sh — muestrea sensores térmicos y RPM del ventilador
# cada 2 s, rota el CSV a 10 MB. Útil para cazar qué sensor dispara el ventilador.

LOG=/var/log/bookos/thermal.csv
MAX_BYTES=10485760

mkdir -p "$(dirname "$LOG")"

# Cabecera si el archivo es nuevo
if [ ! -s "$LOG" ]; then
    echo "ts,profile,fan_rpm,cpu_pkg,cpu_core,nvme,wifi,sns1,sns2,sns3,acpitz,pl1_uw,pl2_uw,bat_current_ua,ac_online" > "$LOG"
fi

read_val() { [ -r "$1" ] && cat "$1" 2>/dev/null || echo ""; }
tz() {
    for z in /sys/class/thermal/thermal_zone*; do
        [ "$(cat "$z/type" 2>/dev/null)" = "$1" ] || continue
        t=$(cat "$z/temp" 2>/dev/null); [ -n "$t" ] && echo "$((t/1000))" && return
    done
    echo ""
}

while :; do
    # Rota si excede el límite
    sz=$(stat -c%s "$LOG" 2>/dev/null || echo 0)
    if [ "$sz" -gt "$MAX_BYTES" ]; then
        mv "$LOG" "$LOG.1"
        echo "ts,profile,fan_rpm,cpu_pkg,cpu_core,nvme,wifi,sns1,sns2,sns3,acpitz,pl1_uw,pl2_uw,bat_current_ua,ac_online" > "$LOG"
    fi

    ts=$(date +%s)
    prof=$(read_val /sys/class/platform-profile/platform-profile-0/profile)
    [ -z "$prof" ] && prof=$(read_val /sys/firmware/acpi/platform_profile)
    fan=$(read_val /sys/devices/pci0000:00/0000:00:1f.0/PNP0C0B:00/hwmon/hwmon*/fan1_input 2>/dev/null | head -1)
    [ -z "$fan" ] && fan=$(cat /sys/class/hwmon/hwmon*/fan1_input 2>/dev/null | head -1)

    cpu_pkg=$(tz x86_pkg_temp)
    cpu_core=$(tz TCPU)
    nvme=$(cat /sys/class/hwmon/hwmon*/temp1_input 2>/dev/null | while read t; do d=$(dirname $(ls /sys/class/hwmon/hwmon*/temp1_input 2>/dev/null | head -1)); break; done; for n in /sys/class/hwmon/hwmon*/name; do [ "$(cat $n)" = "nvme" ] && cat "$(dirname $n)/temp1_input" 2>/dev/null && break; done)
    [ -n "$nvme" ] && nvme=$((nvme/1000))
    wifi=$(tz iwlwifi_1)
    sns1=$(tz SNS1)
    sns2=$(tz SNS2)
    sns3=$(tz SNS3)
    acpitz=$(tz acpitz)
    pl1=$(read_val /sys/class/powercap/intel-rapl:0/constraint_0_power_limit_uw)
    pl2=$(read_val /sys/class/powercap/intel-rapl:0/constraint_1_power_limit_uw)
    bcur=$(read_val /sys/class/power_supply/BAT1/current_now)
    [ -z "$bcur" ] && bcur=$(read_val /sys/class/power_supply/BAT0/current_now)
    ac=$(read_val /sys/class/power_supply/ADP1/online)
    [ -z "$ac" ] && ac=$(read_val /sys/class/power_supply/AC/online)

    echo "$ts,$prof,$fan,$cpu_pkg,$cpu_core,$nvme,$wifi,$sns1,$sns2,$sns3,$acpitz,$pl1,$pl2,$bcur,$ac" >> "$LOG"
    sleep 2
done
