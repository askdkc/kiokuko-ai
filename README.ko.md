# Kiokuko (記憶庫) for OpenCode

[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | 한국어

**MCP로 연결하고, 필요한 기억을 검색하고, 작업 후 지식을 축적합니다.**

Kiokuko는 OpenCode를 위한 로컬 외부 메모리 도입 플러그인입니다. 지식을 SQLite에 저장하고 다음 작업에 관련된 문맥을 검색하며,
재사용 가능한 결과를 기록합니다.

```text
요청 → MCP 연결 → 관련 기억 검색 → 작업 수행
                             ↓
                         재사용 지식 저장
```

기억은 Project·Ecosystem·Global로 분리되고 현재 코드, 설정, 실행 결과가 과거 기억보다 우선합니다.

## 빠른 시작

Node.js 24.16.0 이상이 필요합니다（Node.js 26.1.0 이상도 지원）.

```bash
npm install --global kiokuko-ai
kiokuko-ai setup
```

`setup`은 데이터베이스를 초기화하고 표준 Skill, OpenCode MCP, npm 플러그인을 설정합니다. 이미 실행 중인 OpenCode는
설정 후 재시작하십시오. 정확한 규칙은 [영문 Getting started](docs/getting-started.md)를 참조하십시오.

## 주요 기능

- RAG 기억（기본 lexical, 선택적 로컬 semantic 검색）
- 모호한 요청을 구체화하는 Akinator
- 계획·확인·검증·복구를 담당하는 役小角(enno-oduno)
- 기억을 검토하는 로컬 Web UI
- 자동 실행하지 않는 검증된 참조 전용 External Skill

선택적 semantic 검색도 `setup`과 같은 클라이언트 설정 흐름을 사용합니다.

```bash
kiokuko-ai embeddings setup
```

managed MCP block과 프로젝트 instructions를 갱신합니다. unmanaged identity 교체는 대화형 확인 후에만 수행되며,
비대화형 또는 `--dry-run --json` 실행은 변경 없이 fail closed합니다. 자세한 내용은 [영문 semantic retrieval](docs/semantic-retrieval.md)을 보십시오.

## 지원 클라이언트

지원 클라이언트는 OpenCode 하나입니다. 설정, 재시작, Web UI 안내는
[영문 Getting started](docs/getting-started.md)에 정리되어 있습니다.

## 안전성과 제한

전체 대화를 저장하지 않으며 비밀번호, API key, token, private key처럼 보이는 내용은 거부합니다. 기억은 참고 정보이므로 현재 코드와 실행 결과를 확인하십시오.

MCP tool 호출은 클라이언트와 모델이 결정하므로 모델이 모든 턴에서 Kiokuko의 MCP tool을 호출한다는 보장은 없습니다. OpenCode plugin hook의 자동 처리는 MCP tool 호출과 별도로 실행됩니다. 신뢰 경계와 공개 오류는
[영문 Security and trust](docs/security-and-trust.md)에 설명되어 있습니다.

## 자세한 문서

[영문 문서 목차](docs/README.md)에서 Getting started, Concepts, Enno-Oduno, Semantic retrieval, Security and trust와 구현자용 문서로 이동할 수 있습니다.
