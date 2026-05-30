import sys,re
p=sys.argv[1]
html=open(p,encoding='utf-8').read()
big=max(re.findall(r'<script>(.*?)</script>', html, re.S),key=len)
open('_c.js','w',encoding='utf-8').write(big)
print("braces:",big.count('{')-big.count('}'),"parens:",big.count('(')-big.count(')'),"backticks even:",big.count('`')%2==0)
for n in ['onboardingView','openPurchaseAssistant','provisionAssistant','ASSISTANT_PLANS','provisioned']:
    print(" ",n,":",big.count(n))
