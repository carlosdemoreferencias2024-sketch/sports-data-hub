import re
import unicodedata


def normalize_alias(value: str) -> str:
    normalized = unicodedata.normalize("NFD", value)
    without_marks = "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")
    lowered = without_marks.lower()
    compact = re.sub(r"[^a-z0-9]+", " ", lowered)
    return re.sub(r"\s+", " ", compact).strip()
