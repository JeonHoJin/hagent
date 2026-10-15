# hagent

나만의 AI 에이전트와 대화하는 웹앱. 관리자가 승인한 계정만 쓸 수 있다.
GitHub Pages에는 정적 파일만 올라가고, 대화는 공개 게이트웨이
`https://168-107-32-199.sslip.io`의 `agent-*` operation으로 주고받는다.

## 흐름

1. **시작하기**를 누르면 이 기기에 로그인 키(내보낼 수 없는 ECDSA P-256 키)를 만들어 IndexedDB에 둔다. 로그인 토큰은 메모리에만 둔다.
2. 승인 전에는 계정 코드(사용자 id 앞 8자리)를 보여 준다. 관리자가 승인하면 **다시 확인**으로 들어간다.
3. 메시지를 보내면 작업 id를 바로 받고, 답은 롱폴링으로 조각마다 받아 이어 붙인다.
   - 새로고침해도 진행 중인 답을 이어서 받는다.
   - 폴링 간격은 게이트웨이의 속도 제한 아래로 둔다.
4. 설정에서 패스키를 등록해 두면 다른 기기나 브라우저 데이터를 지운 뒤에도 같은 계정으로 돌아온다.

## 보안

- **CSP**(빌드할 때 넣는다)
  - 스크립트와 스타일은 이 앱의 `assets/` 경로에서만 받는다. 같은 origin의 다른 앱 파일은 쓰지 않는다.
  - 연결은 게이트웨이로만 한다.
  - `object-src`, `base-uri`, `form-action`은 막는다.
  - Trusted Types(`require-trusted-types-for 'script'`)를 쓰며, `hagent-worker` 정책은 앱의 정확한 서비스 워커 URL만 허용한다. HTML·스크립트 문자열은 허용하지 않는다.
  - 페이지는 `no-referrer`다.
- **frame-buster**: Pages는 `X-Frame-Options`를 보낼 수 없으므로, 프레임 안에서 열리면 스스로 비우고 최상위 창을 이 주소로 옮긴다.
- **서버 응답은 믿지 않는다.**
  - 모양과 크기를 검사한 뒤에 쓴다.
  - 텍스트로만 그린다. 에이전트 답 안의 자격 증명 없는 `https:` URL만 링크(`noopener noreferrer`)가 된다.
- **저장소 이름**: 기기 키 DB 이름에 앱 경로를 넣는다(`hagent-keys:<경로>`). 서비스 워커는 없다.
- **실행 시점 의존성**: 없다. 개발 도구는 Vite와 TypeScript뿐이다.
- **받아들인 위험**
  - `jeonhojin.github.io` origin을 같은 계정의 다른 앱과 함께 쓴다. 그 앱들에 XSS가 생기면 이 앱의 기기 키를 쓸 수 있다.
  - 에이전트는 웹을 검색하고 읽는다. 웹 페이지에 숨긴 지시에 속아, 그 사용자 본인의 대화나 메모를 밖으로 보낼 수 있다.

## 개발

```bash
npm ci
npm test          # node:test, TypeScript를 그대로 실행
npm run typecheck
npm run mock      # 가짜 API로 화면 보기 (빌드에는 들어가지 않음)
npm run build
```

`main`에 push하면 Actions가 테스트, 타입 검사, 빌드를 거쳐 Pages에 배포한다.
