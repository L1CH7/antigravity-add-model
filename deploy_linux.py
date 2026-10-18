#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "rich>=13.0.0",
# ]
# ///
"""
Antigravity Add-Model Micro-TUI Manager
Управление установкой патчей, переключением путей, восстановлением и контролем блокировок.
"""

import sys
import os
import json
import hashlib
import subprocess
import shutil
import tty
import termios
import select
from pathlib import Path
from typing import Optional, List, Dict, Any

from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text
from rich.prompt import Prompt

console = Console()

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR
DEPLOY_MJS = SCRIPT_DIR / "scripts" / "deploy.mjs"
HISTORY_FILE = SCRIPT_DIR / ".history_paths.json"

DEFAULT_CANDIDATE_PATHS = [
    "/opt/Antigravity/resources",
    "/opt/antigravity/resources",
    "/opt/Antigravity-IDE/resources",
    "/opt/antigravity-ide/resources",
    str(Path.home() / ".local/share/Programs/antigravity/resources"),
    "/usr/lib/Antigravity/resources",
    "/usr/lib/antigravity/resources",
    "/usr/local/lib/Antigravity/resources",
    "/usr/local/lib/antigravity/resources",
]


def fix_file_ownership(filepath: Path) -> None:
    """Если скрипт запущен под sudo, возвращаем владение файлом оригинальному пользователю."""
    sudo_user = os.environ.get("SUDO_USER")
    if sudo_user and filepath.exists():
        try:
            import pwd
            pw = pwd.getpwnam(sudo_user)
            os.chown(filepath, pw.pw_uid, pw.pw_gid)
        except Exception:
            pass


def load_history() -> Dict[str, Any]:
    if HISTORY_FILE.exists():
        try:
            with open(HISTORY_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    return data
        except Exception:
            pass
    return {"recent_paths": [], "last_selected": None}


def save_history(history: Dict[str, Any]) -> None:
    try:
        with open(HISTORY_FILE, "w", encoding="utf-8") as f:
            json.dump(history, f, indent=2, ensure_ascii=False)
        fix_file_ownership(HISTORY_FILE)
    except Exception as e:
        console.print(f"[dim red]Не удалось сохранить историю путей: {e}[/]")


def get_all_candidate_paths() -> List[str]:
    hist = load_history()
    recent = hist.get("recent_paths", [])
    combined = []
    for p in recent + DEFAULT_CANDIDATE_PATHS:
        normalized = os.path.normpath(p)
        if normalized not in combined:
            combined.append(normalized)
    return combined


def find_default_path() -> Optional[str]:
    hist = load_history()
    last = hist.get("last_selected")
    if last and Path(last).exists():
        return last
    for p in get_all_candidate_paths():
        path_obj = Path(p)
        if (path_obj / "app.asar").exists():
            return str(path_obj.resolve())
    return None


def calculate_sha256(filepath: Path) -> Optional[str]:
    if not filepath.exists() or not filepath.is_file():
        return None
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


def get_single_key(prompt_text: str = "") -> str:
    """Считывает одно нажатие клавиши без необходимости нажимать Enter."""
    if prompt_text:
        console.print(prompt_text, end="")
        sys.stdout.flush()

    if not sys.stdin.isatty():
        line = sys.stdin.readline()
        if not line:
            return "q"
        return line.strip()[:1].lower()

    fd = sys.stdin.fileno()
    old_settings = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        ch = sys.stdin.read(1)
        if ch == "\x03":  # Ctrl+C
            raise KeyboardInterrupt()
        if ch == "\x1b":  # ESC or escape sequence
            r, _, _ = select.select([sys.stdin], [], [], 0.05)
            if r:
                sys.stdin.read(2)  # consume rest of escape sequence
            return "q"
        return ch
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)


def pause(msg: str = "\n[dim]Нажмите любую клавишу для продолжения...[/]") -> None:
    console.print(msg, end="")
    sys.stdout.flush()
    try:
        get_single_key()
    except KeyboardInterrupt:
        raise
    console.print()


def confirm_single_key(prompt_text: str, default: bool = True) -> bool:
    hint = "[Y/n]" if default else "[y/N]"
    console.print(f"{prompt_text} {hint}: ", end="")
    sys.stdout.flush()
    key = get_single_key().lower()
    console.print(f"[bold yellow]{key}[/]")
    if key in ["\r", "\n", " "]:
        return default
    if key in ["y", "д", "1"]:
        return True
    if key in ["n", "н", "0", "q"]:
        return False
    return default


def check_antigravity_processes() -> List[int]:
    """Возвращает PID активных процессов Antigravity или language_server (строго по имени бинарника)."""
    pids = []
    my_pid = os.getpid()
    try:
        # Используем -x (точное совпадение имени процесса), чтобы исключить любые скрипты, папки и пути
        res = subprocess.run(["pgrep", "-x", "antigravity|language_server"], capture_output=True, text=True)
        if res.returncode == 0:
            for line in res.stdout.strip().splitlines():
                try:
                    pid = int(line.strip())
                    if pid != my_pid:
                        pids.append(pid)
                except ValueError:
                    pass
    except Exception:
        pass
    return pids


def kill_antigravity_processes() -> bool:
    console.print("[yellow]Завершение процессов Antigravity и language_server...[/]")
    try:
        # Используем -x для строгого совпадения по имени процесса
        subprocess.run(["pkill", "-9", "-x", "antigravity"], check=False)
        subprocess.run(["pkill", "-9", "-x", "language_server"], check=False)
        return True
    except Exception as e:
        console.print(f"[red]Ошибка при завершении процессов: {e}[/]")
        return False


def inspect_installation(resources_dir: str) -> Dict[str, Any]:
    res_path = Path(resources_dir)
    app_asar = res_path / "app.asar"
    meta_dir = res_path / ".antigravity-model-patch"
    state_file = meta_dir / "state.json"
    lock_file = meta_dir / "deploy.lock"

    status: Dict[str, Any] = {
        "exists": res_path.exists(),
        "app_asar_exists": app_asar.exists(),
        "app_asar_sha256": calculate_sha256(app_asar) if app_asar.exists() else None,
        "state_exists": state_file.exists(),
        "state": None,
        "lock_exists": lock_file.exists(),
        "lock_info": None,
        "writable": os.access(res_path, os.W_OK) if res_path.exists() else False,
        "kind": "UNKNOWN",
        "version": "Неизвестно",
    }

    if lock_file.exists():
        try:
            content = lock_file.read_text(encoding="utf-8").strip()
            status["lock_info"] = content
        except Exception:
            status["lock_info"] = "Чтение заблокировано"

    if state_file.exists():
        try:
            with open(state_file, "r", encoding="utf-8") as f:
                state_data = json.load(f)
                status["state"] = state_data
                status["version"] = state_data.get("version", "Неизвестно")
                patched_hash = state_data.get("patched", {}).get("archive")
                current_hash = status["app_asar_sha256"]

                if current_hash and patched_hash == current_hash:
                    status["kind"] = "PATCHED"
                else:
                    status["kind"] = "AUR_UPDATED"
        except Exception:
            status["kind"] = "INVALID_STATE"
    elif app_asar.exists():
        status["kind"] = "CLEAN"
        # Читаем версию из архива package.json через node/asar если возможно
        try:
            res = subprocess.run(
                ["node", "-e", f'const asar = require("@electron/asar"); console.log(JSON.parse(asar.extractFile("{app_asar}", "package.json")).version);'],
                cwd=str(PROJECT_DIR),
                capture_output=True,
                text=True,
                timeout=5,
            )
            if res.returncode == 0 and res.stdout.strip():
                status["version"] = res.stdout.strip()
        except Exception:
            pass

    return status


def needs_sudo(resources_dir: str) -> bool:
    if os.geteuid() == 0:
        return False
    path = Path(resources_dir)
    if not path.exists():
        # Проверяем доступность родительской директории
        return not os.access(path.parent, os.W_OK)
    return not os.access(path, os.W_OK)


def elevate_sudo(args: List[str]) -> None:
    """Перезапуск через sudo с передачей параметров."""
    console.print("\n[bold yellow]⚡ Каталог требует прав администратора. Выполняю запрос прав через sudo...[/]")
    uv_bin = shutil.which("uv") or "/usr/bin/uv"
    cmd = ["sudo", uv_bin, "run", "--directory", str(PROJECT_DIR), "deploy-linux", *args]
    try:
        os.execvp("sudo", cmd)
    except Exception as e:
        console.print(f"[bold red]Не удалось выполнить sudo: {e}[/]")
        sys.exit(1)


def clean_stale_locks(resources_dir: str) -> None:
    res_path = Path(resources_dir)
    meta_dir = res_path / ".antigravity-model-patch"
    lock_file = meta_dir / "deploy.lock"
    cleaned = False

    if lock_file.exists():
        try:
            lock_file.unlink()
            console.print(f"[green]✓ Файл блокировки успешно удален: {lock_file}[/]")
            cleaned = True
        except Exception as e:
            console.print(f"[red]Ошибка при удалении {lock_file}: {e}[/]")

    # Удаляем зависшие временные каталоги .antigravity-patch-*
    for p in res_path.glob(".antigravity-patch-*"):
        try:
            if p.is_dir():
                shutil.rmtree(p)
                console.print(f"[green]✓ Очищен временный каталог: {p}[/]")
                cleaned = True
        except Exception as e:
            console.print(f"[red]Ошибка при удалении {p}: {e}[/]")

    if not cleaned:
        console.print("[dim]Зависших блокировок и временных файлов не обнаружено.[/]")


def run_deploy_command(action: str, resources_dir: str, force: bool = False) -> int:
    cmd = ["node", str(DEPLOY_MJS), "--resources", resources_dir]
    if action == "check":
        cmd.append("--check")
    elif action == "restore":
        cmd.append("--restore")
        if force:
            cmd.append("--force")
    elif action == "deploy":
        cmd.append("--modular")

    console.print(f"\n[cyan]Выполнение:[/] [dim]{' '.join(cmd)}[/]\n")
    proc = subprocess.run(cmd, cwd=str(PROJECT_DIR))
    return proc.returncode


def render_ui(current_path: str, info: Dict[str, Any], running_pids: List[int]) -> None:
    console.clear()

    # Заголовок
    header = Text()
    header.append("🚀 Antigravity Add-Model Manager ", style="bold bright_cyan")
    header.append("│ Модульный установщик моделей", style="dim")
    console.print(Panel(header, border_style="cyan"))

    # Таблица состояния
    table = Table(box=None, expand=True)
    table.add_column("Параметр", style="bold white", width=26)
    table.add_column("Значение", style="bright_white")

    # Путь
    path_text = Text(current_path)
    if not info["exists"]:
        path_text.stylize("bold red")
        path_text.append(" [КАТАЛОГ НЕ НАЙДЕН]")
    elif not info["writable"]:
        path_text.append(" [Только чтение - требуется sudo]", style="yellow")
    else:
        path_text.append(" [Доступен на запись]", style="green")
    table.add_row("Целевая папка:", path_text)

    # Версия
    table.add_row("Версия Antigravity:", f"[bold white]{info['version']}[/]")

    # Статус патча
    kind = info["kind"]
    if kind == "PATCHED":
        status_text = Text("✓ ПРОПАТЧЕН (модульный патч активен)", style="bold green")
    elif kind == "CLEAN":
        status_text = Text("○ ЧИСТЫЙ (оригинальная вендорная версия)", style="bold cyan")
    elif kind == "AUR_UPDATED":
        status_text = Text("▲ ОБНОВЛЕН AUR / ПАКЕТНЫМ МЕНЕДЖЕРОМ (готов к повторному патчингу)", style="bold yellow")
    elif kind == "INVALID_STATE":
        status_text = Text("⚠ Поврежденное состояние патча", style="bold red")
    else:
        status_text = Text("✕ app.asar не обнаружен", style="bold red")
    table.add_row("Состояние инсталляции:", status_text)

    # Запущенные процессы
    if running_pids:
        proc_text = Text(f"⚠ ЗАПУЩЕН (PIDs: {', '.join(map(str, running_pids))})", style="bold red")
        proc_text.append(" — Закройте перед операциями!")
    else:
        proc_text = Text("✓ Не запущен (безопасно для патчинга)", style="green")
    table.add_row("Процессы Antigravity:", proc_text)

    # Блокировка
    if info["lock_exists"]:
        lock_text = Text(f"⚠ АКТИВНА ({info['lock_info']})", style="bold red")
    else:
        lock_text = Text("Отсутствует", style="dim")
    table.add_row("Файл блокировки:", lock_text)

    console.print(Panel(table, title="[bold]Текущий статус[/]", border_style="blue"))

    # Меню действий
    menu = Table(box=None, expand=True)
    menu.add_column("Клавиша", style="bold bright_yellow", width=10)
    menu.add_column("Действие", style="bright_white")

    menu.add_row("[1]", "Установить / Обновить патч (Modular Deploy)")
    menu.add_row("[2]", "Восстановить исходную версию (Restore)")
    menu.add_row("[3]", "Проверить целостность (Check integrity)")
    menu.add_row("[4]", "Выбрать другой путь к ресурсам (Select Path)")
    menu.add_row("[5]", "Снять зависшие блокировки / очистить temp (Clean locks)")
    if running_pids:
        menu.add_row("[K]", "[bold red]Принудительно закрыть Antigravity (killall)[/]")
    menu.add_row("[Q]", "Выход")

    console.print(Panel(menu, title="[bold]Доступные действия[/]", border_style="green"))


def select_path_dialog(current_path: str) -> str:
    console.clear()
    console.print(Panel("[bold]Выбор каталога ресурсов Antigravity[/]", border_style="cyan"))

    candidates = get_all_candidate_paths()
    table = Table(box=None, expand=True)
    table.add_column("№", style="bold yellow", width=5)
    table.add_column("Путь", style="bright_white")
    table.add_column("Статус", style="bold")

    for idx, cand in enumerate(candidates, start=1):
        cand_path = Path(cand)
        is_current = (cand == current_path)
        status_text = Text()
        if (cand_path / "app.asar").exists():
            status_text.append("НАЙДЕН", style="green")
        else:
            status_text.append("НЕТ", style="dim")
        if is_current:
            status_text.append(" (ТЕКУЩИЙ)", style="bold cyan")

        prefix = "-> " if is_current else "   "
        table.add_row(f"{prefix}[{idx}]", cand, status_text)

    console.print(table)
    console.print("\n[bold yellow][1-9][/] — Выбрать путь по номеру (одно нажатие)")
    console.print("[bold yellow][C][/]   — Ввести собственный путь вручную")
    console.print("[bold yellow][Q][/]   — Назад в главное меню (без изменений)")
    console.print("\n[bold cyan]Ваш выбор:[/] ", end="")
    sys.stdout.flush()

    key = get_single_key().lower()
    console.print(f"[bold yellow]{key}[/]")

    selected = current_path
    if key in ["q", "\x1b"]:
        return current_path
    elif key.isdigit():
        num = int(key)
        if 1 <= num <= len(candidates):
            selected = candidates[num - 1]
    elif key == "c":
        custom = Prompt.ask("\n[bold cyan]Введите абсолютный путь к папке resources[/]", default=current_path).strip()
        if custom:
            selected = str(Path(custom).resolve())

    # Сохраняем в историю
    hist = load_history()
    recent = hist.get("recent_paths", [])
    if selected in recent:
        recent.remove(selected)
    recent.insert(0, selected)
    hist["recent_paths"] = recent[:10]
    hist["last_selected"] = selected
    save_history(hist)

    return selected


def interactive_loop() -> None:
    current_path = find_default_path() or "/opt/Antigravity/resources"

    while True:
        info = inspect_installation(current_path)
        pids = check_antigravity_processes()
        render_ui(current_path, info, pids)

        console.print("\n[bold cyan]Выберите действие (1-5, K, Q): [/]", end="")
        sys.stdout.flush()
        action = get_single_key().lower()
        if action in ["\r", "\n"]:
            action = "1"
        console.print(f"[bold yellow]{action}[/]")

        if action in ["q", "\x1b"]:
            console.print("[dim]Выход.[/]")
            break

        elif action == "k":
            kill_antigravity_processes()
            pause()

        elif action == "4":
            current_path = select_path_dialog(current_path)

        elif action == "5":
            if needs_sudo(current_path):
                elevate_sudo(["--clean-locks", "--resources", current_path])
            clean_stale_locks(current_path)
            pause()

        elif action in ["1", "2", "3"]:
            # Проверка запущенных процессов
            current_pids = check_antigravity_processes()
            if current_pids and action in ["1", "2"]:
                console.print("\n[bold red]ВНИМАНИЕ: Обнаружены работающие процессы Antigravity![/]")
                if confirm_single_key("Завершить процессы автоматически перед операцией?", default=True):
                    kill_antigravity_processes()
                else:
                    console.print("[yellow]Операция отменена. Закройте Antigravity вручную.[/]")
                    pause()
                    continue

            # Проверка прав записи
            if needs_sudo(current_path):
                sub_flag = "--modular" if action == "1" else ("--restore" if action == "2" else "--check")
                elevate_sudo(["--resources", current_path, sub_flag])

            if action == "1":
                # Авто-сборка дистрибутива перед патчем если нужно
                dist_dir = PROJECT_DIR / "dist"
                if not (dist_dir / "proxy.js").exists():
                    console.print("[yellow]Сборка TypeScript-проекта (npm run build)...[/]")
                    subprocess.run(["npm", "run", "build"], cwd=str(PROJECT_DIR), check=False)

                run_deploy_command("deploy", current_path)
            elif action == "2":
                rc = run_deploy_command("restore", current_path)
                if rc != 0 and info["kind"] == "AUR_UPDATED":
                    if confirm_single_key("\nПакет был обновлен через AUR. Выполнить форсированное восстановление (--force)?", default=False):
                        run_deploy_command("restore", current_path, force=True)
            elif action == "3":
                run_deploy_command("check", current_path)

            pause()


def main() -> None:
    # Прямой CLI-режим если переданы аргументы командной строки
    if len(sys.argv) > 1:
        # Специальный флаг --clean-locks
        if "--clean-locks" in sys.argv:
            res_idx = sys.argv.index("--resources") if "--resources" in sys.argv else -1
            res_path = sys.argv[res_idx + 1] if res_idx != -1 and res_idx + 1 < len(sys.argv) else find_default_path()
            if res_path:
                clean_stale_locks(res_path)
            return

        # Проверяем необходимость sudo для указанного --resources (только для модифицирующих операций)
        is_read_only = "--check" in sys.argv or "-h" in sys.argv or "--help" in sys.argv
        if not is_read_only:
            res_idx = sys.argv.index("--resources") if "--resources" in sys.argv else -1
            target_path = sys.argv[res_idx + 1] if res_idx != -1 and res_idx + 1 < len(sys.argv) else find_default_path()
            if target_path and needs_sudo(target_path) and os.geteuid() != 0:
                elevate_sudo(sys.argv[1:])

        # Прямой проброс аргументов в deploy.mjs
        cmd = ["node", str(DEPLOY_MJS), *sys.argv[1:]]
        proc = subprocess.run(cmd, cwd=str(PROJECT_DIR))
        sys.exit(proc.returncode)

    # Интерактивный режим Micro-TUI
    try:
        interactive_loop()
    except KeyboardInterrupt:
        console.print("\n[dim]Сеанс прерван пользователем.[/]")
        sys.exit(0)


if __name__ == "__main__":
    main()
