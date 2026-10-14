"""Acesso ao Supabase pela API REST (PostgREST), usando a chave secreta."""

import os

import requests


class DB:
    def __init__(self):
        self.base = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1"
        key = os.environ["SUPABASE_SECRET_KEY"]
        self.s = requests.Session()
        self.s.headers.update({"apikey": key, "Content-Type": "application/json"})
        # chaves antigas (JWT) também precisam do Authorization
        if key.startswith("eyJ"):
            self.s.headers["Authorization"] = f"Bearer {key}"

    def _check(self, r: requests.Response):
        if r.status_code >= 400:
            raise RuntimeError(f"Supabase {r.status_code}: {r.text[:300]}")
        return r

    def select(self, table: str, params: dict | None = None) -> list[dict]:
        return self._check(self.s.get(f"{self.base}/{table}", params=params or {}, timeout=30)).json()

    def select_all(self, table: str, params: dict | None = None, page: int = 1000) -> list[dict]:
        """Busca todas as linhas, paginando (o Supabase limita 1000 por resposta)."""
        rows, offset = [], 0
        while True:
            batch = self.select(table, {**(params or {}), "limit": page, "offset": offset})
            rows.extend(batch)
            if len(batch) < page:
                return rows
            offset += page

    def insert(self, table: str, rows: list[dict] | dict, returning: bool = False):
        if isinstance(rows, list) and not rows:
            return []
        headers = {"Prefer": "return=representation" if returning else "return=minimal"}
        r = self._check(self.s.post(f"{self.base}/{table}", json=rows, headers=headers, timeout=30))
        return r.json() if returning else None

    def update(self, table: str, match: dict, values: dict, returning: bool = False):
        headers = {"Prefer": "return=representation" if returning else "return=minimal"}
        r = self._check(self.s.patch(f"{self.base}/{table}", params=match, json=values, headers=headers, timeout=30))
        return r.json() if returning else None

    def delete(self, table: str, match: dict):
        self._check(self.s.delete(f"{self.base}/{table}", params=match, timeout=30))
