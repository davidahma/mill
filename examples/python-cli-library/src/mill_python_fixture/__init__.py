def allocate(available: int, requested: int) -> int:
    if available < 0 or requested < 0:
        raise ValueError("negative capacity")
    return min(available, requested)
