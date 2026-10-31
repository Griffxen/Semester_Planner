"""Consistent backups with bounded managed retention; legacy backups stay untouched."""
import argparse
import datetime as dt
import os
import re
import secrets
import sqlite3
from contextlib import closing
from pathlib import Path

BJ = dt.timezone(dt.timedelta(hours=8))
MANAGED = re.compile(r'^planner-managed-(\d{8})-(\d{6})-(\d{6})\.db$')


def managed_timestamp(name):
    match = MANAGED.fullmatch(name)
    if not match: return None
    try: return dt.datetime.strptime(''.join(match.groups()),'%Y%m%d%H%M%S%f').replace(tzinfo=BJ)
    except ValueError: return None


def prune_managed(folder, now=None):
    now = (now or dt.datetime.now(BJ)).astimezone(BJ)
    daily_start = now.date()-dt.timedelta(days=29); month_index = now.year*12+now.month-1
    daily, monthly, candidates = {}, {}, []
    for file in Path(folder).iterdir():
        if file.is_symlink() or not file.is_file(): continue
        moment = managed_timestamp(file.name)
        if moment is None or moment>now: continue
        candidates.append(file)
        if moment.date()>=daily_start:
            key = moment.date()
            if key not in daily or moment>daily[key][0]: daily[key]=(moment,file)
        key = moment.year*12+moment.month-1
        if month_index-11<=key<=month_index:
            if key not in monthly or moment>monthly[key][0]: monthly[key]=(moment,file)
    keep = {item[1] for item in (*daily.values(),*monthly.values())}; removed = []
    for file in candidates:
        if file not in keep: file.unlink(); removed.append(file)
    return removed


def make_backup(db_path, output='backups', now=None, rotate=True):
    db = Path(db_path).resolve()
    if not db.is_file(): raise FileNotFoundError('Database does not exist')
    folder = Path(output); folder.mkdir(parents=True,exist_ok=True)
    moment = (now or dt.datetime.now(BJ)).astimezone(BJ)
    target = folder/('planner-managed-'+moment.strftime('%Y%m%d-%H%M%S-%f')+'.db')
    while target.exists() or target.is_symlink():
        moment += dt.timedelta(microseconds=1)
        target = folder/('planner-managed-'+moment.strftime('%Y%m%d-%H%M%S-%f')+'.db')
    temporary = folder/('.'+target.name+'.'+secrets.token_hex(8)+'.partial')
    fd = os.open(temporary,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600); os.close(fd)
    try:
        with closing(sqlite3.connect(db.as_uri()+'?mode=ro',uri=True)) as src, closing(sqlite3.connect(temporary)) as dst:
            src.backup(dst)
            if dst.execute('PRAGMA quick_check').fetchone()[0]!='ok': raise RuntimeError('Backup integrity check failed')
            dst.commit()
        os.link(temporary,target); temporary.unlink()
    except Exception:
        temporary.unlink(missing_ok=True); raise
    if rotate: prune_managed(folder,max(moment,(now or dt.datetime.now(BJ)).astimezone(BJ)))
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',default=os.environ.get('PLANNER_BACKUP_DIR','backups'))
    parser.add_argument('--db',default=os.environ.get('PLANNER_DB',str(Path(__file__).resolve().parent/'data/planner.db')))
    parser.add_argument('--no-rotate',action='store_true',help='keep all managed backups for this run')
    args = parser.parse_args()
    try: print(make_backup(args.db,args.output,rotate=not args.no_rotate))
    except (OSError,sqlite3.Error,RuntimeError) as error: raise SystemExit(str(error))


if __name__=='__main__': main()
