#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Local logging for protobuf2openai package to avoid cross-package dependencies.
"""
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path

# 改为使用 /tmp 目录
LOG_DIR = Path("/tmp/logs")
try:
    LOG_DIR.mkdir(exist_ok=True)
    use_file_logging = True
except OSError:
    use_file_logging = False

_logger = logging.getLogger("protobuf2openai")
_logger.setLevel(logging.INFO)

# Remove existing handlers to prevent duplication
for h in _logger.handlers[:]:
    _logger.removeHandler(h)

# 只有在能创建目录时才添加文件处理器
if use_file_logging:
    file_handler = RotatingFileHandler(LOG_DIR / "openai_compat.log", maxBytes=5*1024*1024, backupCount=3, encoding="utf-8")
    file_handler.setLevel(logging.INFO)
    fmt = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(funcName)s:%(lineno)d - %(message)s')
    file_handler.setFormatter(fmt)
    _logger.addHandler(file_handler)

console_handler = logging.StreamHandler()
console_handler.setLevel(logging.INFO)
fmt = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(funcName)s:%(lineno)d - %(message)s')
console_handler.setFormatter(fmt)
_logger.addHandler(console_handler)

logger = _logger
