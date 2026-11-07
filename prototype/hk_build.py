"""北海道鳥類目録505種の一覧と、BirdNETとの対応（自動対応＋承認済み対応）を書き出す。DBは読み取りのみ。
自動対応 = 学名が一致し、かつ和名（マスター和名・目録掲載名）の一致先が食い違わないもの。それ以外は承認済み対応表(APPROVED)のみ。"""
import sqlite3, json, hashlib, sys, datetime
db, labels, outdir = sys.argv[1], sys.argv[2], sys.argv[3]
SQL = """select m.species_id, m.japanese_name, l.listed_name, m.scientific_name, e.residency_hokkaido
  from species_listing l join species_master m using(species_id) left join ecology e using(species_id)
  where l.list_code='HOKKAIDO5' order by l.list_seq"""
# 2026-11-07 ユーザー承認（Aの11件）。目録の学名 → BirdNETの学名（複数可）
APPROVED = {
  'Anser cygnoid': ['Anser cygnoides'], 'Eudromias morinellus': ['Charadrius morinellus'],
  'Locustella certhiola': ['Helopsaltes certhiola'], 'Locustella ochotensis': ['Helopsaltes ochotensis'],
  'Larus vegae': ['Larus argentatus'], 'Parus cinereus': ['Parus minor'],
  'Phylloscopus plumbeitarsus': ['Phylloscopus plumbeitarsus'], 'Emberiza personata': ['Emberiza spodocephala'],
  'Anser fabalis': ['Anser serrirostris', 'Anser fabalis'],
  'Calandrella brachydactyla': ['Calandrella dukhunensis', 'Calandrella brachydactyla'],
}
# 2026-11-07 ユーザー承認: 目録外だが北海道にいる種（鳥類DBの北海道目録に無い）。鳥類DBの species_master の種IDを使う
EXTRA = [
  {'id': 'BD467', 'birdnet': ['Urosphena squameiceps'],
   'reason': '北海道で普通の夏鳥だが、鳥類DBの北海道目録（HOKKAIDO5）に登録が無い。目録外の追加種として扱う（鳥類DBは書き換えない）'},
]
c = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
rows = list(c.execute(SQL))
raw = open(labels, 'rb').read()
lab = [l.split('_', 1) for l in raw.decode('utf-8').splitlines() if l]
by_sci = {s: j for s, j in lab}
by_ja = {}
for s, j in lab: by_ja.setdefault(j, s)
species, alias, stat = [], {}, {'auto': 0, 'approved': 0, 'none': 0}
for sid, mja, lja, sci, resd in rows:
    jas = [by_ja[n] for n in {mja, lja} if n in by_ja]
    if sci in APPROVED:
        assert all(t in by_sci for t in APPROVED[sci]), sci
        alias[sid] = APPROVED[sci]; st = 'approved'; bn = []
    elif sci in by_sci and all(t == sci for t in jas):
        st = 'auto'; bn = [sci]
    else:
        st = 'none'; bn = []
    stat[st] += 1
    species.append({'id': sid, 'master_ja': mja, 'list_ja': lja, 'sci': sci, 'residency': resd, 'birdnet': bn, 'status': st})
assert len(species) == 505 and len({s['id'] for s in species}) == 505
base_ids = {s['id'] for s in species}
extra = []
for x in EXTRA:
    r = c.execute('select species_id, japanese_name, scientific_name from species_master where species_id=?', (x['id'],)).fetchone()
    assert r and x['id'] not in base_ids, x['id']
    assert all(t in by_sci for t in x['birdnet']), x
    extra.append({'id': r[0], 'list_ja': r[1], 'master_ja': r[1], 'sci': r[2], 'birdnet': x['birdnet'], 'reason': x['reason'], 'approved_at': '2026-11-07'})
now = datetime.datetime.now().isoformat(timespec='seconds')
json.dump({'format': 'hokkaido-list', 'version': 1, 'species': species}, open(f'{outdir}/hokkaido_list.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
json.dump({'format': 'hokkaido-alias', 'version': 1, 'approved_at': '2026-11-07', 'approved_by': 'user', 'alias': alias, 'extra': extra}, open(f'{outdir}/hokkaido_alias.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
json.dump({'generated': now, 'source_db': 'bird_database.db species_listing HOKKAIDO5（北海道鳥類目録）', 'sql': SQL,
           'rule': '自動対応=学名一致かつ和名一致先が食い違わない／承認済み対応=hokkaido_alias.json／それ以外=BirdNET該当なし',
           'labels_sha256': hashlib.sha256(raw).hexdigest(), 'counts': stat, 'total': len(species), 'extra': len(extra)},
          open(f'{outdir}/hokkaido_list.meta.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(stat)
