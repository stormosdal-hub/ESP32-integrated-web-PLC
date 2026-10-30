/* Unit tests for the compact JSON DOM (components/plc_core/jdom.c).
 *   gcc -std=c11 -Icomponents/plc_core/include components/plc_core/jdom.c test/host/test_jdom.c -o build_host/test_jdom
 */
#include <stdio.h>
#include <string.h>

#include "jdom.h"

static int fails;
#define CHECK(cond)                                                         \
    do {                                                                    \
        if (!(cond)) {                                                      \
            printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);          \
            fails++;                                                        \
        }                                                                   \
    } while (0)

static int parse(jd_doc_t *d, const char *s) { return jd_parse(d, s, strlen(s), NULL); }

int main(void)
{
    jd_doc_t d;
    char buf[64];

    /* whitespace everywhere, empty containers, nesting */
    const char *a = " { \"a\" : [ ] , \"b\" :{ } ,\n\t\"c\": [ 1 , [ ] , { \"x\" : null } , -2.5e3 ] , \"d\":true } ";
    CHECK(parse(&d, a));
    CHECK(jd_type(&d, 0) == JD_OBJ && jd_count(&d, 0) == 4);
    CHECK(jd_count(&d, jd_get(&d, 0, "a")) == 0 && jd_first(&d, jd_get(&d, 0, "a")) < 0);
    CHECK(jd_count(&d, jd_get(&d, 0, "b")) == 0);
    int c = jd_get(&d, 0, "c");
    CHECK(jd_count(&d, c) == 4);
    int e = jd_first(&d, c);
    CHECK(jd_num(&d, e, 0) == 1);
    e = jd_next(&d, e);
    CHECK(jd_type(&d, e) == JD_ARR && jd_count(&d, e) == 0);
    e = jd_next(&d, e);
    CHECK(jd_type(&d, jd_get(&d, e, "x")) == JD_NULL);
    e = jd_next(&d, e);
    CHECK(jd_num(&d, e, 0) == -2500);
    CHECK(jd_next(&d, e) < 0);
    CHECK(jd_bool(&d, jd_get(&d, 0, "d"), false));
    CHECK(jd_get(&d, 0, "missing") < 0);
    jd_release(&d, NULL);

    /* keys that are prefixes of each other; escaped keys */
    CHECK(parse(&d, "{\"ab\":1,\"a\":2,\"abc\":3,\"q\\\"k\":4,\"\\u0041\":5}"));
    CHECK(jd_num(&d, jd_get(&d, 0, "a"), 0) == 2);
    CHECK(jd_num(&d, jd_get(&d, 0, "ab"), 0) == 1);
    CHECK(jd_num(&d, jd_get(&d, 0, "abc"), 0) == 3);
    CHECK(jd_num(&d, jd_get(&d, 0, "q\"k"), 0) == 4);
    CHECK(jd_num(&d, jd_get(&d, 0, "A"), 0) == 5);
    jd_release(&d, NULL);

    /* string decoding: escapes, BMP and astral code points, raw UTF-8 */
    CHECK(parse(&d, "[\"l1\\nl2\\t\\\\\\/\", \"\\u00f8\\u00e6\", \"\\ud83d\\ude00\", \"N\xc3\xb8" "dstopp\", \"\"]"));
    int s = jd_first(&d, 0);
    CHECK(jd_str(&d, s, buf, sizeof buf) == 8 && !strcmp(buf, "l1\nl2\t\\/"));
    s = jd_next(&d, s);
    CHECK(!strcmp((jd_str(&d, s, buf, sizeof buf), buf), "\xc3\xb8\xc3\xa6"));
    s = jd_next(&d, s);
    CHECK(jd_str(&d, s, buf, sizeof buf) == 4 && !memcmp(buf, "\xf0\x9f\x98\x80", 4));
    s = jd_next(&d, s);
    CHECK(!strcmp((jd_str(&d, s, buf, sizeof buf), buf), "N\xc3\xb8" "dstopp"));
    s = jd_next(&d, s);
    CHECK(jd_str(&d, s, buf, sizeof buf) == 0 && !jd_bool(&d, s, true));
    jd_release(&d, NULL);

    /* truncation reporting: needed length is returned */
    CHECK(parse(&d, "\"0123456789\""));
    CHECK(jd_str(&d, 0, buf, 5) == 10 && !strcmp(buf, "0123"));
    CHECK(jd_str(&d, 0, NULL, 0) == 10);
    jd_release(&d, NULL);

    /* numbers given as strings, booleans as numbers */
    CHECK(parse(&d, "{\"pin\":\"17\",\"bad\":\"17x\",\"t\":true,\"n\":1e2}"));
    CHECK(jd_num(&d, jd_get(&d, 0, "pin"), -1) == 17);
    CHECK(jd_num(&d, jd_get(&d, 0, "bad"), -1) == -1);
    CHECK(jd_num(&d, jd_get(&d, 0, "t"), -1) == 1);
    CHECK(jd_num(&d, jd_get(&d, 0, "n"), -1) == 100);
    jd_release(&d, NULL);

    /* malformed input must be rejected */
    const char *bad[] = {"", "{", "[1,]x", "{\"a\" 1}", "{\"a\":1,}", "[1 2]", "\"open", "{1:2}", "nul", "[-]", "{}}", NULL};
    for (int i = 0; bad[i]; i++) {
        int ok = parse(&d, bad[i]);
        if (ok) printf("accepted bad JSON #%d: %s\n", i, bad[i]);
        CHECK(!ok);
        jd_release(&d, NULL);
    }
    /* UTF-8 BOM tolerated */
    CHECK(parse(&d, "\xef\xbb\xbf{\"k\":[]}"));
    jd_release(&d, NULL);

    printf(fails ? "%d jdom check(s) FAILED\n" : "jdom: all checks pass\n", fails);
    return fails ? 1 : 0;
}
