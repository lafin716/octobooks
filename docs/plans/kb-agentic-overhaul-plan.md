# 지식베이스 전면 개편 — 벡터 제거·Agentic 탐색·폴더 관리 (2026-11-09, ADR-136~140)

이 계획은 `kb-types-overhaul-plan.md`(ADR-127~134)를 대체한다. 코드베이스와 문서를 나누던 유형 구분과 벡터 색인을 없애고, 모든 지식베이스를 "파일 폴더 + Agentic 탐색"으로 통일한다.

## 목표 (사용자 요구 1~5)
1. 지식베이스 하나에 파일을 여러 개 넣는다. 넣는 방법은 세 가지다.
   - 직접 업로드: 선택 또는 드래그앤드롭.
   - GitHub에서 가져오기.
   - 링크 URL.
2. 파일은 KB 폴더(`<userData>/knowledge/<id>/files/`)에서 관리한다. 학습(루트 세션)마다 여러 KB를 연결할 수 있고(`knowledgeIds[]`), 같은 KB를 여러 학습에 연결해도 된다.
3. 벡터 DB를 완전히 제거한다. 코드와 문서 모두 MCP 도구로 직접 탐색한다(findFiles, grep, list, read, outline, defs).
   - 질문마다 미리 검색하는 단계(retrieveForChat)를 없앤다.
   - 모델이 질문에 KB 자료가 필요할 때만 도구를 쓴다. 예약이나 퀴즈 요청, 잡담에는 쓰지 않는다.
   - `skill-knowledge`는 학습에 연결된 KB 폴더를 탐색하도록 바꾼다.
4. 팝업은 열 때 목록만 보여 준다(파일을 훑지 않는다).
   - 폴더는 한 단계씩 읽는다(`tree(id, dir)`). 하위 폴더는 클릭할 때 읽는다.
   - 읽는 중에는 스피너를 보인다.
5. 팝업을 다시 디자인한다.
   - 제거: 자동 색인, 검색 테스트, KB 설정(임베딩), 색인 상태, 유형 필터·배지, 유형 선택 단계, RAG 모드 설정, 인용 칩, 근거 보기.
   - 상세 화면 위쪽: 업로드 영역(드래그앤드롭), GitHub(clone/ZIP 선택), 링크.
   - 상세 화면 아래쪽: 폴더 브라우저(브레드크럼, 단계별 로드). 파일과 폴더마다 삭제할 수 있고, clone 저장소에는 Pull 버튼이 있다.
   - 설명은 상세 화면 머리글에서 바로 편집한다(KB 설정 대화상자 없음).

## 완료 기준 (DoD)
- `rag` 벡터 모듈이 없다. 지워지는 것:
  - core: embedding, retrieval, rewrite, expand, sufficiency, router, contextBuilder, chunk, metrics, folders, parse, prompt, hash, tokenize.
  - bridge: rag/*, kbTools의 indexSearch·searchKnowledge.
  - desktop: ragWorker.
  - sqlite 사용처: KB 색인만.
- 퀴즈·예약 요청에 KB 도구를 부르지 않는다. 확인 방법은 두 가지다.
  - 단위 테스트: store가 사전 검색을 하지 않는다.
  - 시스템 안내 문구 테스트: 조건부 사용 규칙이 포함된다.
- 팝업을 열 때 `tree(id, '')`만 부른다. 스피너가 보이고, 폴더를 클릭해야 그 아래를 부른다.
- 기능 동작:
  - GitHub clone 방식에는 `.git`이 남고 Pull이 된다.
  - ZIP 방식에는 `.git`이 없고 Pull 버튼도 없다.
  - 파일과 폴더를 삭제할 수 있다.
  - 여러 KB를 연결하면 모든 KB 폴더를 탐색한다.
- 남은 색인 파일 처리: 기존 `index*.sqlite*`와 `backup/`은 시작할 때 지운다. 파생 데이터이므로 `files/`는 건드리지 않는다.
- 검증:
  - `pnpm typecheck && pnpm lint && pnpm test` PASS.
  - `pnpm e2e` PASS. 지식베이스 e2e를 새로 쓴다.
  - 데스크탑 앱을 패키징하고 실행한다.

## 결정 (DECISIONS.md)
- **ADR-136**: 벡터·RAG 파이프라인과 KB 유형(kind)을 완전히 제거하고, 모든 KB를 Agentic 탐색으로 통일한다.
  - `linkedPath`가 있는 구버전 KB는 읽기 전용으로 계속 탐색할 수 있다. 업로드·클론·삭제는 막는다.
  - 남은 색인 파일과 백업은 시작할 때 정리한다(멱등, 원본 보존).
  - Message의 citations와 ragQuery는 더 이상 만들지 않는다. 구버전 데이터의 필드는 무시한다.
- **ADR-137**: 사전 검색을 없애고 KB 사용 여부를 질문에 따라 정한다.
  - bridge 안내문에 다음을 넣는다.
    - KB 목록(이름, 설명).
    - "질문이 이 자료의 내용을 요구할 때만 도구 사용. 일정·타이머·퀴즈 출제 요청·잡담·일반 지식에는 쓰지 말 것."
  - RagSettings(fast/auto/deep/semantic)와 그 설정 화면을 없앤다.
- **ADR-138**: GitHub 가져오기는 clone과 zip 두 방식이다.
  - clone: `git clone --depth 1`로 `.git`을 유지하고, `git pull --ff-only --depth 1`로 갱신한다. git 하드닝은 ADR-133과 같다.
  - zip: `codeload.github.com/<o>/<r>/tar.gz/HEAD` 압축 파일을 받아 Node(zlib와 내장 tar 파서)로 푼다. 외부 의존성은 없다.
    - UI 표기는 "ZIP 다운로드"지만 실제 형식은 tar.gz다. GitHub가 같은 내용을 주고, zip 해제 라이브러리를 추가하지 않기 위해서다.
    - 링크와 경로 탈출, 크기와 개수 한도를 막는다.
  - 출처 기록(meta.sources)에 mode를 남긴다.
- **ADR-139**: 팝업은 단계별로 불러온다.
  - `tree(id, dir)`는 한 단계만 읽는다. dir은 필수이고 폴더가 먼저 온다.
  - 목록은 캐시된 통계만 쓴다.
  - 팝업을 열 때 색인 상태와 출처를 부르지 않는다. 출처는 tree 항목의 source 필드로 받는다.
- **ADR-140**: 문서(PDF)도 Agentic으로 탐색한다.
  - grep, read, outline 도구가 PDF를 만나면 pdfjs로 뽑은 텍스트를 쓴다. 뽑은 텍스트는 `<kb>/cache/text/` 캐시에 두고, 파일 mtime과 크기가 바뀌면 다시 뽑는다.
  - 결과 경로는 원래 PDF 경로를 쓴다.
  - 그 밖의 바이너리는 binary_file로 처리한다.

## 계약 (리더 소유, 확정)
- `packages/core/src/knowledge.ts`:
  - KnowledgeBase에서 kind, kindSuggestion, excludes를 뺀다. linkedPath는 읽기 전용으로 남긴다.
  - KnowledgeCreateOptions는 `{description?}`만 받는다.
  - 새 타입: GitImportMode, `isGitImportMode`, KnowledgeSource(rag/types에서 옮기고 mode를 더함).
  - KnowledgeEntry에 `source?`를 더한다.
  - 진행 phase에 'pull'과 'extract'를 더한다.
- `packages/core/src/bridge/desktop.ts` DesktopKnowledgeApi는 다음과 같다. 색인·유형 API는 모두 지운다.
  - list, create, rename, setDescription, remove.
  - `tree(id, dir)`.
  - pathForFile, addPaths, addFiles, pickFiles, addLink.
  - `cloneGit(id, url, {mode})`, `pullGit(id, path)`.
  - removeEntry, preview, open, onProgress, cancel.
- 원격 sync RPC 이름은 `knowledge.<method>`이고, 위 메서드를 그대로 따른다(`knowledge.pullGit`, `knowledge.setDescription` 추가).
- ChatStartMsg에서 `knowledgeMode`를 제거한다. `knowledgeIds`와 구버전용 `knowledgeId`는 유지한다.
- MCP 도구 `KB_TOOL_NAMES`는 다음과 같다. `searchKnowledge`(색인 검색)는 지운다.
  - listKnowledgeDirectory, readKnowledgeFile, getKnowledgeOutline, findFiles, grepKnowledge, findDefinitions.
- 답변 trace: `Message.ragTrace`는 KB 도구 호출 수만 기록한다(`{ toolCalls: number }` 등 최소 형태). UI는 0보다 클 때만 "지식베이스 탐색 N회"를 한 줄로 보인다.

## Task Graph · 소유권
| ID | 작업 | 소유 | 의존 | 난이도 |
|---|---|---|---|---|
| K1 | 계약(knowledge.ts, desktop.ts), 계획, ADR | 리더 | – | HIGH |
| K2 | core 정리: rag 벡터 모듈 삭제, knowledgePolicy 축소, model·provider·protocol, store 사전 검색 제거, tools.ts 정리, skill-knowledge ×5 언어와 LEGACY 업그레이드, core 테스트 | Agent C | K1 | HIGH |
| K3 | bridge, desktop, server: knowledgeStore(kind, 색인, 설정 제거, tree source, removeEntry 폴더, clone/zip/pull), 색인 정리 마이그레이션, rag 삭제, kbTools(전체 KB 탐색, PDF 텍스트, 안내문 조건부 규칙), main/ipc/preload/kbGuard, ragWorker 삭제, bridge 테스트, eval 정리 | Agent A | K1 (K2와 병렬, core 심볼 삭제 결과에 맞춘다) | HIGH |
| K4 | UI: KnowledgeDialog 재설계, KnowledgeCreate 단순화, Insights, SearchTest, IndexStatus, SourceViewer, Citation 삭제, RagTraceLine 축소, 설정의 RAG 섹션 삭제, syncRpc와 remoteKnowledge, vault import 정리, knowledge·settings·rag·chat 문구 ×5 언어, e2e 재작성 | Agent B | K1 | HIGH |
| K5 | 통합: typecheck, lint, test, e2e | 리더 | K2–K4 | MEDIUM |
| K6 | 독립 리뷰 → 수정 | Reviewer | K5 | HIGH |
| K7 | 데스크탑 패키징·실행, 문서(knowledge-architecture, PROGRESS), 커밋·릴리스 | 리더 | K6 | MEDIUM |

i18n 파일 소유:
- Agent B: knowledge, settings, rag, chat, vault.
- Agent C: skillsBuiltin, skills, core.
- Agent A: bridge, desktop, cli.

실행 모델은 모두 현재 Claude 모델(Opus)을 상속한다. effort는 따로 고르지 않는다.
