# KIS Developers (한국투자증권 OpenAPI) 공식 문서 및 API 상세

한국투자증권(KIS)은 개발자들을 위해 주식 시세 조회, 매매 주문, 계좌 조회 등을 자동화할 수 있는 RESTful API를 제공합니다.

## 🔗 공식 링크 및 리소스

*   **공식 API 포털 (KIS Developers):** [https://apiportal.koreainvestment.com](https://apiportal.koreainvestment.com)
*   **공식 GitHub 저장소 (샘플 코드):** [https://github.com/koreainvestment/open-trading-api](https://github.com/koreainvestment/open-trading-api)

---

## 🔑 1. 인증 체계 (OAuth 2.0 기반)

API를 호출하기 위해서는 발급받은 Key를 이용해 **접근 토큰(Access Token)** 을 발급받아야 합니다.

### 접근 토큰 발급 (`/oauth2/tokenP`)
*   **Method**: `POST`
*   **Header**: `{"Content-Type": "application/json"}`
*   **Request Body**:
```json
{
  "grant_type": "client_credentials",
  "appkey": "{포털에서 발급받은 App Key}",
  "appsecret": "{포털에서 발급받은 App Secret}"
}
```
*   **Response**:
```json
{
  "access_token": "eyJhbE... (긴 토큰 문자열)",
  "token_type": "Bearer",
  "expires_in": 86400
}
```

> **주의:** 토큰은 24시간 동안 유효합니다. 빈번하게 재발급 시 API 차단이 발생할 수 있으므로 1회 발급 후 캐싱하여 사용해야 합니다.

---

## 🚦 2. 공통 헤더(Header) 규격

모든 주문/조회 API 호출 시 아래의 헤더를 필수적으로 포함해야 합니다.

```json
{
  "Content-Type": "application/json",
  "Authorization": "Bearer {access_token}",
  "appkey": "{발급받은 app key}",
  "appsecret": "{발급받은 app secret}",
  "tr_id": "{기능별 고유 식별자}",
  "custtype": "P" // 개인(P), 법인(B)
}
```

---

## 📊 3. 국내주식 주요 API 상세 (Request / Response)

### ① 국내주식 현재가 조회
*   **Endpoint**: `/uapi/domestic-stock/v1/quotations/inquire-price`
*   **Method**: `GET`
*   **Header (`tr_id`)**: `FHKST01010100`
*   **Request Query Params**:
    *   `fid_cond_mrkt_div_code`: `'J'` (주식/ETF)
    *   `fid_input_iscd`: `005930` (종목코드 6자리)

### ② 국내주식 일봉/차트 데이터 조회
*   **Endpoint**: `/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice`
*   **Method**: `GET`
*   **Header (`tr_id`)**: `FHKST03010100`

### ③ 국내주식 주문 (매수/매도)
*   **Endpoint**: `/uapi/domestic-stock/v1/trading/order-cash`
*   **Method**: `POST`
*   **Header (`tr_id`)**: 
    *   매수: `TTTC0802U` (모의투자: `VTTC0802U`)
    *   매도: `TTTC0801U` (모의투자: `VTTC0801U`)

### ④ 국내 계좌 잔고 및 예수금 조회
*   **Endpoint**: `/uapi/domestic-stock/v1/trading/inquire-balance`
*   **Method**: `GET`
*   **Header (`tr_id`)**: `TTTC8434R` (모의투자: `VTTC8434R`)
*   **Request Query Params**:
    *   `CANO`: 계좌번호 앞 8자리
    *   `ACNT_PRDT_CD`: 계좌상품코드 (보통 `01`)
    *   `INQR_DVSN`: `'02'`
    *   `UNPR_DVSN`: `'01'`
*   **Response**:
    *   `output1`: 보유 종목 배열 (`pdno` 종목코드, `prdt_name` 종목명, `hldg_qty` 보유수량 등)
    *   `output2`: 계좌 요약 (첫 번째 요소의 `dnca_tot_amt`가 원화 예수금액을 나타냄)

---

## 🌎 4. 해외주식 주요 API 상세 (Request / Response)

### ① 해외주식 일봉/차트 데이터 조회
*   **Endpoint**: `/uapi/overseas-price/v1/quotations/dailyprice`
*   **Method**: `GET`
*   **Header (`tr_id`)**: `HHDFS76240000` (모의투자: `VHHDFS76240000`)

### ② 해외주식 주문 (매수/매도)
*   **Endpoint**: `/uapi/overseas-stock/v1/trading/order`
*   **Method**: `POST`
*   **Header (`tr_id`)**: 
    *   매수: `JTTT1002U` (모의투자: `VTTT1002U`)
    *   매도: `JTTT1006U` (모의투자: `VTTT1001U`)

### ③ 해외 계좌 잔고 조회 (보유 종목)
*   **Endpoint**: `/uapi/overseas-stock/v1/trading/inquire-balance`
*   **Method**: `GET`
*   **Header (`tr_id`)**: `TTTS3012R` (모의투자: `CTRP6504R`)
*   **Request Query Params**:
    *   `CANO` / `ACNT_PRDT_CD`
    *   `OVRS_EXCG_CD`: 해외 거래소 코드 (`NASD`, `NYSE`, `AMEX`)
    *   `TR_CRCY_CD`: `'USD'`
*   **Response (`output1`)**: 보유 종목 배열 (`ovrs_pdno` 심볼, `ovrs_item_name` 종목명, `ovrs_cblc_qty` 잔고수량, `pchs_avg_pric` 매입평균가 등)
> **연속조회 주의:** 해외 주식 잔고는 응답 헤더의 `tr_cont` 값이 "M" 또는 "F"일 때 페이징용 Key(`CTX_AREA_FK200`)를 받아 반복적으로 호출해야 전체 보유 목록을 확인할 수 있습니다.

### ④ 해외 예수금 및 가주문 가능금액 조회
*   **Endpoint**: `/uapi/overseas-stock/v1/trading/inquire-psamount`
*   **Method**: `GET`
*   **Header (`tr_id`)**: `TTTS3007R` (모의투자: `VTTS3007R`)
*   **Request Query Params**: `CANO`, `ACNT_PRDT_CD`, `OVRS_EXCG_CD`: `'NASD'`, `OVRS_ORD_UNPR`: `'0'`, `ITEM_CD`: `''`
*   **Response (`output.frcr_ord_psbl_amt1`)**: 외화(USD) 주식 매수 가능 금액

---

## 🚫 5. 주요 에러 코드 예시

*   **`EGW00123` / `EGW00201`** : Request 파라미터 또는 헤더 포맷 누락 오류
*   **`EGW00121`** : 토큰이 만료되었거나 유효하지 않은 Authorization 헤더 (재발급 필요)
*   **API 호출 한도 에러** (`429 Too Many Requests` 상태코드): 초당 20건(통상적)의 트래픽 리밋을 초과했습니다. Delay 또는 Queue 로직이 필요합니다.
