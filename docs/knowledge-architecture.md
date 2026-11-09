# 지식베이스 아키텍처 — 파일 폴더 + Agentic 탐색 (ADR-136~140, 2026-11-09)

이 문서는 2026-11-06의 Codebase(Agentic)·Document(Hybrid) 구조(ADR-127~134)를 대체한다. 벡터 색인, KB 유형(kind), 사전 검색은 모두 제거됐다.

## 1. 한눈에

- KB 하나는 **파일 폴더 하나**다: `<userData>/knowledge/<kbId>/`.
  - `meta.json`: 이름, 설명, 출처(sources).
  - `files/`: 원본 파일(Source of Truth).
  - `cache/text/`: PDF에서 뽑은 텍스트 캐시(파생 데이터).
- 파일을 넣는 방법:
  - 직접 업로드: 파일 선택 또는 끌어 놓기. 폴더도 넣을 수 있다.
  - GitHub: clone 방식과 ZIP 방식 중에서 고른다.
  - 링크 URL: 페이지를 마크다운으로 저장한다.
- 학습(루트 세션)에 `knowledgeIds[]`로 여러 KB를 연결한다. 같은 KB를 여러 학습에 연결할 수 있다.
- 답변 모델은 **필요할 때만** 읽기 전용 MCP 도구로 연결된 KB 폴더를 직접 탐색한다. 미리 검색하는 단계는 없다.

## 2. 데이터 소유권

| 데이터 | 위치 | 성격 |
|---|---|---|
| 원본 파일 | `<kb>/files/**` | Source of Truth. 사용자가 지우기 전에는 보존한다 |
| 메타·출처 | `<kb>/meta.json` | Source of Truth. `sources[path] = { kind, location, mode? }` |
| PDF 텍스트 | `<kb>/cache/text/` | 파생 데이터. mtime이나 크기가 바뀌면 다시 뽑는다 |
| 구버전 색인 | `<kb>/index*.sqlite*`, `<kb>/backup/` | 시작할 때 지운다(멱등). `files/`는 건드리지 않는다 |
| 남은 임시 폴더 | `<kb>/files/.clone-*`, `.zip-*` | 중단된 가져오기의 흔적. 시작할 때 지운다 |

구버전에서 외부 폴더를 연결한 KB(`linkedPath`)는 **읽기 전용**이다. 탐색은 되지만 업로드, 가져오기, 삭제는 막는다.

## 3. 가져오기 (bridge `knowledgeStore.ts`)

- 업로드와 폴더 추가: 경로 탈출과 심볼릭 링크를 막는다. 파일 하나는 20MB, KB 하나는 500MB(`KNOWLEDGE_LIMITS`)까지 넣을 수 있다. 이름이 겹치면 고유한 이름을 붙인다.
- **GitHub clone**:
  - `git clone --depth 1`로 받고 `.git`을 남긴다. 저장 위치는 `files/repos/<name>`이다.
  - 받는 동안 2초마다 임시 폴더의 크기를 잰다(`.git` 포함). 남은 용량을 넘으면 중단하고 "용량 한도" 오류를 낸다.
  - 갱신은 **Pull**로 한다: `git pull --ff-only --depth 1`.
  - git 하드닝은 ADR-133과 같다: 셸을 쓰지 않고, 인자를 고정하며, hooks와 프롬프트를 끈다.
- **GitHub ZIP**:
  - `codeload.github.com/<o>/<r>/tar.gz/HEAD`를 받아 Node zlib와 내장 tar 파서(`tarExtract.ts`)로 푼다. pax 확장 헤더를 지원한다.
  - 링크, 경로 탈출, 크기와 개수 한도를 막는다. `.git`이 없으므로 Pull도 없다.
- 두 방식 모두 임시 폴더에 받은 뒤 `placeImported`로 옮기고 출처를 기록한다. 출처 기록이 실패하면 옮긴 폴더를 지운다.
- 삭제(`removeEntry`): 파일과 폴더 모두 지울 수 있다. 출처 메타를 먼저 저장한 뒤 지운다.

## 4. 팝업 로딩 (ADR-139)

- `tree(id, dir)`는 **한 단계만** 읽는다. 폴더가 먼저 오고, 항목마다 `source`(clone이면 Pull 버튼 표시)가 붙는다.
- 팝업을 열면 목록(캐시된 통계)만 부른다. 상세 화면은 `tree(id, '')`, 폴더를 클릭하면 `tree(id, 'a/b')`를 부른다. 읽는 동안 스피너를 보인다.
- 늦게 도착한 응답은 버린다(`levelSeq`). 선택한 KB나 폴더가 바뀐 뒤 도착한 결과는 반영하지 않는다.

## 5. Agentic 탐색 도구 (bridge `kbTools/*`, core `rag/tools.ts`)

| 도구 | 용도 |
|---|---|
| `listKnowledgeDirectory` | 폴더 한 단계 보기 |
| `findFiles` | 파일 이름이나 glob으로 찾기 |
| `grepKnowledge` | 내용 검색. PDF는 추출한 텍스트에서 찾는다 |
| `findDefinitions` | 함수, 클래스 같은 심볼 정의 찾기 |
| `getKnowledgeOutline` | 파일 하나의 구조(제목, 심볼) 보기 |
| `readKnowledgeFile` | 줄 범위를 지정해 읽기 |

- MCP 서버는 세션에 연결된 KB id만 허용한다. KB를 여러 개 연결하면 모두 탐색한다.
- 결과는 `<kb_content>` 데이터로 감싼다. PDF 결과의 경로는 원래 PDF 경로를 쓴다.
- 답변 trace(`Message.ragTrace = { toolCalls }`)에는 KB 도구 호출 수만 남긴다. UI는 0보다 클 때 "지식베이스 탐색 N회"를 보인다.

## 6. 조건부 사용 (ADR-137)

- 질문마다 미리 검색하던 `retrieveForChat`를 없앴다.
- bridge 안내문, 도구 안내, 기본 스킬 세 곳에 같은 규칙을 넣었다.
  - 연결된 KB 목록(이름, 설명)을 알려 준다.
  - **질문이 그 자료의 내용을 요구할 때만** 도구를 쓴다.
  - 일정, 타이머, 예약, 퀴즈 출제 요청, 잡담, 일반 지식 질문에는 쓰지 않는다. 예를 들어 "5분 뒤 퀴즈 내줘"에는 쓰지 않는다.
- 이 규칙은 모델에 주는 안내다. 코드로 강제하지는 않는다.

## 7. 기본 스킬 "지식베이스 탐색" (`skill-knowledge`)

- 프롬프트는 `i18n/locales/*/skillsBuiltin.json`의 `knowledge`에 5개 언어로 있다.
- 사용자가 고치지 않은 구버전 프롬프트는 `skillsLegacy.ts`가 새 프롬프트로 바꾼다.
- 탐색 순서:
  1. 연결된 KB 폴더를 확인한다.
  2. `findFiles`, `grepKnowledge`, `findDefinitions`로 후보를 찾는다.
  3. `readKnowledgeFile`로 원문을 확인한다.
  4. 출처 경로와 함께 답한다.

## 8. API / IPC (core `bridge/desktop.ts` `DesktopKnowledgeApi`)

```
list · create(name, { description }) · rename · setDescription · remove
tree(id, dir) · pathForFile · addPaths · addFiles · pickFiles · addLink
cloneGit(id, url, { mode: 'clone' | 'zip' }) · pullGit(id, path)
removeEntry · preview · open · onProgress · cancel
```

- main은 모든 인자를 `kbGuard.ts`에서 다시 검증한다(id 형식, 경로, 모드, 설명).
- 원격 sync RPC는 같은 이름의 `knowledge.<method>`다. git 작업은 UI에서 11분까지 기다린다.

## 9. 보안

- KB 내용은 데이터로만 다룬다. 문서 안에 있는 지시문은 따르지 않는다. 도구는 읽기 전용이다.
- 경로 순회, 심볼릭 링크 탈출, 명령 인젝션을 막는다(셸을 쓰지 않고 인자를 고정한다). 비밀 값은 로그에 남기지 않는다.

## 10. 사용법

1. 학습 헤더의 **지식베이스** → **새 지식베이스**: 이름과 설명(선택)을 넣는다.
2. 상세 화면 위쪽에서 자료를 넣는다.
   - 파일을 끌어 놓거나 **파일 선택**을 누른다.
   - GitHub 주소를 넣고 **clone** 또는 **ZIP 다운로드**를 고른다.
   - 링크 URL을 넣는다.
3. 아래쪽 파일 목록에서 폴더를 눌러 들어가고, 브레드크럼으로 돌아온다. 항목마다 삭제할 수 있다. clone 저장소에는 **Pull** 버튼이 있다.
4. 설명은 상세 화면 머리글에서 바로 고친다.
5. 목록에서 KB 이름을 누르면 지금 학습에 연결하거나 해제한다. 여러 KB를 연결할 수 있다.
