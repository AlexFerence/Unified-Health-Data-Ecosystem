#!/usr/bin/env bash
# cron-manager.sh — Interactive cron job manager for macOS
# Manages the current user's crontab.

set -euo pipefail

# ─── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

DISABLED_PREFIX="#DISABLED#"

# ─── Helpers ───────────────────────────────────────────────────────────────────

# Print the current crontab, filtering out blank lines and plain comment lines
# (but keeping #DISABLED# lines). Outputs raw crontab lines to stdout.
get_crontab_lines() {
    crontab -l 2>/dev/null || true
}

# Build an array of "managed" job lines: all non-blank lines that are either
# normal job lines or #DISABLED# lines. Plain comments (# without DISABLED#)
# and blank lines are preserved in the crontab but not shown as selectable jobs.
# Populates global arrays: JOB_LINES (raw line), JOB_INDICES (1-based line
# numbers in the full crontab).
load_jobs() {
    JOB_LINES=()
    JOB_INDICES=()
    local idx=0
    while IFS= read -r line; do
        idx=$(( idx + 1 ))
        # Skip blank lines and plain comments (not #DISABLED#)
        if [[ -z "$line" ]]; then
            continue
        fi
        if [[ "$line" == \#* && "$line" != "${DISABLED_PREFIX}"* ]]; then
            continue
        fi
        JOB_LINES+=("$line")
        JOB_INDICES+=("$idx")
    done <<< "$(get_crontab_lines)"
}

# Write a new full crontab from a temp file safely.
write_crontab_from_file() {
    local tmpfile="$1"
    crontab "$tmpfile"
}

# Replace line number $1 (1-based) in the crontab with string $2.
replace_crontab_line() {
    local lineno="$1"
    local newline="$2"
    local tmpfile
    tmpfile="$(mktemp /tmp/crontab.XXXXXX)"
    get_crontab_lines > "$tmpfile"
    # Use a Python one-liner for reliable line replacement (avoids sed escaping
    # issues with special characters in cron commands on macOS BSD).
    python3 - "$tmpfile" "$lineno" "$newline" <<'PYEOF'
import sys
path, lineno, newline = sys.argv[1], int(sys.argv[2]), sys.argv[3]
with open(path, 'r') as f:
    lines = f.readlines()
lines[lineno - 1] = newline + '\n'
with open(path, 'w') as f:
    f.writelines(lines)
PYEOF
    crontab "$tmpfile"
    rm -f "$tmpfile"
}

# Remove line number $1 (1-based) from the crontab.
remove_crontab_line() {
    local lineno="$1"
    local tmpfile
    tmpfile="$(mktemp /tmp/crontab.XXXXXX)"
    get_crontab_lines > "$tmpfile"
    python3 - "$tmpfile" "$lineno" <<'PYEOF'
import sys
path, lineno = sys.argv[1], int(sys.argv[2])
with open(path, 'r') as f:
    lines = f.readlines()
del lines[lineno - 1]
with open(path, 'w') as f:
    f.writelines(lines)
PYEOF
    crontab "$tmpfile"
    rm -f "$tmpfile"
}

# Pretty-print a single job line. Args: $1=display index, $2=raw line.
print_job() {
    local i="$1"
    local line="$2"
    local status schedule command

    if [[ "$line" == "${DISABLED_PREFIX}"* ]]; then
        status="${RED}DISABLED${RESET}"
        line="${line#"${DISABLED_PREFIX}"}"
    else
        status="${GREEN}ENABLED ${RESET}"
    fi

    # Split into schedule (first 5 fields) and command (rest)
    read -r f1 f2 f3 f4 f5 rest <<< "$line"
    schedule="${CYAN}${f1} ${f2} ${f3} ${f4} ${f5}${RESET}"
    command="$rest"

    printf "  ${BOLD}%2d)${RESET} [%b] %b  %b\n" \
        "$i" "$status" "$schedule" "$command"
}

# Validate that a string looks like a 5-field cron schedule (basic check).
validate_schedule() {
    local sched="$1"
    local count
    count=$(echo "$sched" | awk '{print NF}')
    if [[ "$count" -ne 5 ]]; then
        echo -e "${RED}Error:${RESET} Schedule must have exactly 5 fields (minute hour day month weekday)."
        return 1
    fi
    return 0
}

# ─── Feature: List ─────────────────────────────────────────────────────────────

cmd_list() {
    load_jobs
    if [[ ${#JOB_LINES[@]} -eq 0 ]]; then
        echo -e "${YELLOW}No cron jobs found.${RESET}"
        return
    fi
    echo -e "\n${BOLD}Current cron jobs:${RESET}"
    echo -e "${DIM}  #    Status    Schedule (min hr day mon wday)  Command${RESET}"
    echo -e "${DIM}  ─────────────────────────────────────────────────────────${RESET}"
    local i=1
    for line in "${JOB_LINES[@]}"; do
        print_job "$i" "$line"
        i=$(( i + 1 ))
    done
    echo
}

# ─── Feature: Add ──────────────────────────────────────────────────────────────

cmd_add() {
    echo -e "\n${BOLD}Add a new cron job${RESET}"
    echo -e "${DIM}Enter the schedule as 5 space-separated fields: minute hour day month weekday${RESET}"
    echo -e "${DIM}Examples:  */5 * * * *   (every 5 min)    0 9 * * 1   (9 AM every Monday)${RESET}\n"

    local schedule command
    while true; do
        read -rp "Schedule: " schedule
        if validate_schedule "$schedule"; then
            break
        fi
    done

    read -rp "Command:  " command
    if [[ -z "$command" ]]; then
        echo -e "${RED}Command cannot be empty.${RESET}"
        return
    fi

    local new_line="${schedule} ${command}"
    local tmpfile
    tmpfile="$(mktemp /tmp/crontab.XXXXXX)"
    get_crontab_lines > "$tmpfile"
    echo "$new_line" >> "$tmpfile"
    write_crontab_from_file "$tmpfile"
    rm -f "$tmpfile"

    echo -e "${GREEN}Job added.${RESET}"
}

# ─── Feature: Remove ───────────────────────────────────────────────────────────

cmd_remove() {
    load_jobs
    if [[ ${#JOB_LINES[@]} -eq 0 ]]; then
        echo -e "${YELLOW}No cron jobs to remove.${RESET}"
        return
    fi

    cmd_list
    local choice
    read -rp "Enter job number to remove (or 0 to cancel): " choice
    if [[ "$choice" == "0" || -z "$choice" ]]; then
        return
    fi
    if ! [[ "$choice" =~ ^[0-9]+$ ]] || (( choice < 1 || choice > ${#JOB_LINES[@]} )); then
        echo -e "${RED}Invalid selection.${RESET}"
        return
    fi

    local job_line="${JOB_LINES[$(( choice - 1 ))]}"
    echo -e "\nRemoving: ${DIM}${job_line}${RESET}"
    read -rp "Are you sure? [y/N] " confirm
    if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
        echo "Cancelled."
        return
    fi

    local crontab_lineno="${JOB_INDICES[$(( choice - 1 ))]}"
    remove_crontab_line "$crontab_lineno"
    echo -e "${GREEN}Job removed.${RESET}"
}

# ─── Feature: Enable / Disable ────────────────────────────────────────────────

cmd_toggle() {
    load_jobs
    if [[ ${#JOB_LINES[@]} -eq 0 ]]; then
        echo -e "${YELLOW}No cron jobs found.${RESET}"
        return
    fi

    cmd_list
    local choice
    read -rp "Enter job number to enable/disable (or 0 to cancel): " choice
    if [[ "$choice" == "0" || -z "$choice" ]]; then
        return
    fi
    if ! [[ "$choice" =~ ^[0-9]+$ ]] || (( choice < 1 || choice > ${#JOB_LINES[@]} )); then
        echo -e "${RED}Invalid selection.${RESET}"
        return
    fi

    local job_line="${JOB_LINES[$(( choice - 1 ))]}"
    local crontab_lineno="${JOB_INDICES[$(( choice - 1 ))]}"
    local new_line

    if [[ "$job_line" == "${DISABLED_PREFIX}"* ]]; then
        new_line="${job_line#"${DISABLED_PREFIX}"}"
        replace_crontab_line "$crontab_lineno" "$new_line"
        echo -e "${GREEN}Job enabled.${RESET}"
    else
        new_line="${DISABLED_PREFIX}${job_line}"
        replace_crontab_line "$crontab_lineno" "$new_line"
        echo -e "${YELLOW}Job disabled.${RESET}"
    fi
}

# ─── Feature: Edit ─────────────────────────────────────────────────────────────

cmd_edit() {
    load_jobs
    if [[ ${#JOB_LINES[@]} -eq 0 ]]; then
        echo -e "${YELLOW}No cron jobs to edit.${RESET}"
        return
    fi

    cmd_list
    local choice
    read -rp "Enter job number to edit (or 0 to cancel): " choice
    if [[ "$choice" == "0" || -z "$choice" ]]; then
        return
    fi
    if ! [[ "$choice" =~ ^[0-9]+$ ]] || (( choice < 1 || choice > ${#JOB_LINES[@]} )); then
        echo -e "${RED}Invalid selection.${RESET}"
        return
    fi

    local job_line="${JOB_LINES[$(( choice - 1 ))]}"
    local crontab_lineno="${JOB_INDICES[$(( choice - 1 ))]}"

    # Strip #DISABLED# prefix for editing; will be re-disabled if it was disabled
    local was_disabled=false
    if [[ "$job_line" == "${DISABLED_PREFIX}"* ]]; then
        was_disabled=true
        job_line="${job_line#"${DISABLED_PREFIX}"}"
    fi

    local tmpfile
    tmpfile="$(mktemp /tmp/crontab_edit.XXXXXX)"
    printf '%s\n' "$job_line" > "$tmpfile"

    local editor="${EDITOR:-nano}"
    "$editor" "$tmpfile"

    local new_line
    new_line="$(head -n1 "$tmpfile")"
    rm -f "$tmpfile"

    if [[ -z "$new_line" ]]; then
        echo -e "${RED}Empty line — edit cancelled.${RESET}"
        return
    fi

    # Re-apply disabled prefix if job was disabled
    if [[ "$was_disabled" == true ]]; then
        new_line="${DISABLED_PREFIX}${new_line}"
    fi

    replace_crontab_line "$crontab_lineno" "$new_line"
    echo -e "${GREEN}Job updated.${RESET}"
}

# ─── Feature: View Logs ────────────────────────────────────────────────────────

cmd_logs() {
    load_jobs
    if [[ ${#JOB_LINES[@]} -eq 0 ]]; then
        echo -e "${YELLOW}No cron jobs found.${RESET}"
        return
    fi

    cmd_list
    local choice
    read -rp "Enter job number to view logs (or 0 to cancel): " choice
    if [[ "$choice" == "0" || -z "$choice" ]]; then
        return
    fi
    if ! [[ "$choice" =~ ^[0-9]+$ ]] || (( choice < 1 || choice > ${#JOB_LINES[@]} )); then
        echo -e "${RED}Invalid selection.${RESET}"
        return
    fi

    local job_line="${JOB_LINES[$(( choice - 1 ))]}"

    # Strip #DISABLED# prefix to get the actual command for parsing
    if [[ "$job_line" == "${DISABLED_PREFIX}"* ]]; then
        job_line="${job_line#"${DISABLED_PREFIX}"}"
    fi

    # Extract the command portion (fields 6 onward)
    local command
    command=$(awk '{for(i=6;i<=NF;i++) printf "%s%s",$i,(i<NF?" ":"\n")}' <<< "$job_line")

    echo -e "\n${BOLD}=== macOS System Cron Log (last 24 hours) ===${RESET}\n"
    echo -e "${DIM}Running: log show --predicate 'process == \"cron\"' --last 24h --style syslog${RESET}\n"

    # macOS unified log — may require sudo or Full Disk Access for Terminal
    if ! log show --predicate 'process == "cron"' --last 24h --style syslog 2>/dev/null | \
         grep --color=never -v "^Filtering" | tail -n 100; then
        echo -e "${YELLOW}Note:${RESET} Could not read system logs. Grant Terminal Full Disk Access in:"
        echo "  System Settings → Privacy & Security → Full Disk Access"
        echo "  Or retry with: sudo $0"
    fi

    # ── Application log file (if command redirects output) ──────────────────
    # Look for >> or > followed by a file path in the command
    local logfile=""
    if [[ "$command" =~ \>\>?[[:space:]]*([^[:space:]&\|;]+) ]]; then
        logfile="${BASH_REMATCH[1]}"
        # Expand ~ if present
        logfile="${logfile/#\~/$HOME}"
    fi

    if [[ -n "$logfile" ]]; then
        if [[ -f "$logfile" ]]; then
            echo -e "\n${BOLD}=== Application Log: ${logfile} (last 50 lines) ===${RESET}\n"
            tail -n 50 "$logfile"
        else
            echo -e "\n${YELLOW}Log file ${logfile} not found (job may not have run yet).${RESET}"
        fi
    else
        echo -e "\n${DIM}No output redirection found in command. Add >> /path/to/logfile to capture job output.${RESET}"
    fi
    echo
}

# ─── Main Menu ─────────────────────────────────────────────────────────────────

print_header() {
    echo -e "\n${BOLD}${CYAN}╔══════════════════════════════╗${RESET}"
    echo -e "${BOLD}${CYAN}║      Cron Job Manager        ║${RESET}"
    echo -e "${BOLD}${CYAN}╚══════════════════════════════╝${RESET}"
    echo -e "${DIM}  User: $(whoami)   Machine: $(hostname -s)${RESET}\n"
}

print_menu() {
    echo -e "  ${BOLD}1)${RESET} List jobs"
    echo -e "  ${BOLD}2)${RESET} Add job"
    echo -e "  ${BOLD}3)${RESET} Remove job"
    echo -e "  ${BOLD}4)${RESET} Enable / Disable job"
    echo -e "  ${BOLD}5)${RESET} Edit job"
    echo -e "  ${BOLD}6)${RESET} View logs"
    echo -e "  ${BOLD}7)${RESET} Quit\n"
}

main() {
    # Ensure crontab command is available
    if ! command -v crontab &>/dev/null; then
        echo -e "${RED}Error:${RESET} 'crontab' command not found." >&2
        exit 1
    fi

    print_header

    while true; do
        print_menu
        read -rp "Choose an option [1-7]: " opt
        echo
        case "$opt" in
            1) cmd_list ;;
            2) cmd_add ;;
            3) cmd_remove ;;
            4) cmd_toggle ;;
            5) cmd_edit ;;
            6) cmd_logs ;;
            7) echo -e "${DIM}Goodbye.${RESET}"; exit 0 ;;
            *) echo -e "${RED}Invalid option.${RESET} Please enter 1–7.\n" ;;
        esac
    done
}

main
